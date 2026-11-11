// ═══════════════════════════════════════════════════════════
// WePlay — Node static server (zero-dependency)
// ใช้ได้ทั้ง LOCAL (double-click start-*) และ DEPLOY (หลัง nginx)
//   LOCAL  : start-windows.bat / start-mac-linux.command → PORT=8000
//   DEPLOY : run.sh อ่าน PORT จาก .env  (PRD=8009  DEV=8109)
// nginx: location /m3u8/ { proxy_pass http://127.0.0.1:<PORT>/; }
//        → prefix /m3u8/ ถูก strip ก่อนถึง server นี้ (เสิร์ฟจาก root)
// ไม่มี dependency ภายนอก ใช้แค่ Node core (http/https/fs/path/os/dns)
//
// /proxy?url=<ลิงก์สตรีมจริง>  — ตัวกลางสำหรับ Cast ไปทีวี/Android TV
//   ลิงก์ .m3u8 ของ IPTV หลายเจ้าผูก token กับ IP ของเครื่องที่ขอก่อน เวลา Cast
//   ตรงๆ ตัวรับ (Default Media Receiver) บนทีวีจะไปดึงสตรีมด้วย IP ของทีวีเอง
//   ซึ่งมักไม่ตรงกับ IP ที่ token อนุญาต (เช่น PC ออก IPv6 แต่ทีวีออก IPv4) ทำให้
//   ทีวีค้างที่หน้า Cast เปล่า จุดนี้ให้เครื่องนี้ (เครื่องเดียวกับที่ขอ token) ดึงสตรีม
//   แทนทีวี แล้วส่งต่อให้ — ทีวีจึงไม่ต้องติดต่อ CDN ต้นทางตรงอีก
// ═══════════════════════════════════════════════════════════
'use strict';
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const dns   = require('dns');

const PORT = parseInt(process.env.PORT || '8000', 10);
// 0.0.0.0: ให้อุปกรณ์อื่นในบ้าน (เช่น Android TV ตอน Cast ผ่าน /proxy) เรียกเข้ามาได้
// ตั้ง HOST=127.0.0.1 ใน .env ได้ถ้าต้องการจำกัดเฉพาะ localhost/nginx (เช่นตอน DEPLOY)
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico':  'image/x-icon',
};

// ไฟล์ที่ห้ามเสิร์ฟออกไป (source / secret / log)
const BLOCK = new Set(['server.js', 'run.sh', 'package.json', 'package-lock.json']);
function isBlocked(rel) {
  const base = path.basename(rel);
  return BLOCK.has(base) || base === '.env' || base.startsWith('.env') || rel.endsWith('.log');
}

/* ---------- Chromecast relay proxy (/proxy?url=...) ---------- */

const PROXY_FETCH_TIMEOUT_MS = 15000;
const PROXY_MAX_REDIRECTS = 5;
const PROXY_MAX_MANIFEST_BYTES = 4 * 1024 * 1024; // กัน m3u8 ที่โตไม่จำกัดกินแรม

// กัน SSRF: ห้ามใช้ proxy นี้ยิงเข้าเครือข่ายภายใน/loopback ของเซิร์ฟเวอร์เอง
function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip.includes(':')) {
    const low = ip.toLowerCase();
    return low === '::1' || low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('::ffff:127.');
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function resolveIsSafeHost(hostname) {
  return new Promise((resolve) => {
    dns.lookup(hostname, { all: true }, (err, addrs) => {
      if (err || !addrs || !addrs.length) return resolve(false);
      resolve(addrs.every((a) => !isPrivateIp(a.address)));
    });
  });
}

function fetchUpstream(targetUrl, reqHeaders, cb, redirectsLeft) {
  if (redirectsLeft == null) redirectsLeft = PROXY_MAX_REDIRECTS;
  const mod = targetUrl.protocol === 'https:' ? https : http;
  const headers = { 'user-agent': 'Mozilla/5.0 (WePlay-CastProxy)', accept: '*/*' };
  if (reqHeaders.range) headers.range = reqHeaders.range;
  const reqOpt = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: targetUrl.pathname + (targetUrl.search || ''),
    method: 'GET',
    headers,
  };
  const upstreamReq = mod.request(reqOpt, (upstreamRes) => {
    const loc = upstreamRes.headers.location;
    if (loc && [301, 302, 303, 307, 308].includes(upstreamRes.statusCode) && redirectsLeft > 0) {
      upstreamRes.resume();
      let nextUrl;
      try { nextUrl = new URL(loc, targetUrl); } catch (e) { return cb(new Error('bad redirect')); }
      return fetchUpstream(nextUrl, reqHeaders, cb, redirectsLeft - 1);
    }
    cb(null, upstreamRes);
  });
  upstreamReq.on('error', cb);
  upstreamReq.setTimeout(PROXY_FETCH_TIMEOUT_MS, () => upstreamReq.destroy(new Error('upstream timeout')));
  upstreamReq.end();
}

function isPlaylistResponse(contentType, pathname) {
  if (contentType && /mpegurl/i.test(contentType)) return true;
  const p = pathname.toLowerCase();
  return p.endsWith('.m3u8') || p.endsWith('.m3u');
}

// รีไรต์ URI ในไฟล์ m3u8 (ทั้ง segment, playlist ย่อย, EXT-X-KEY/EXT-X-MAP URI=)
// ให้วนกลับผ่าน /proxy เพื่อให้ทีวียังคงดึงทุกอย่างผ่านเครื่องนี้ ไม่ใช่ตรงจาก CDN
function rewritePlaylist(text, baseUrl) {
  return text.split(/\r?\n/).map((line) => {
    if (line.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/i, (m, uri) => {
        let abs;
        try { abs = new URL(uri, baseUrl).toString(); } catch (e) { return m; }
        return 'URI="/proxy?url=' + encodeURIComponent(abs) + '"';
      });
    }
    const t = line.trim();
    if (!t) return line;
    let abs;
    try { abs = new URL(t, baseUrl).toString(); } catch (e) { return line; }
    return '/proxy?url=' + encodeURIComponent(abs);
  }).join('\n');
}

async function handleProxy(req, res, targetParam) {
  let targetUrl;
  try { targetUrl = new URL(targetParam); } catch (e) { res.writeHead(400); return res.end('Bad url'); }
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    res.writeHead(400); return res.end('Unsupported protocol');
  }
  const safe = await resolveIsSafeHost(targetUrl.hostname);
  if (!safe) { res.writeHead(403); return res.end('Target not allowed'); }

  fetchUpstream(targetUrl, req.headers, (err, upstreamRes) => {
    if (err) { res.writeHead(502); return res.end('Upstream fetch failed'); }
    const contentType = upstreamRes.headers['content-type'] || '';

    if (isPlaylistResponse(contentType, targetUrl.pathname)) {
      let size = 0;
      const chunks = [];
      upstreamRes.on('data', (c) => {
        size += c.length;
        if (size > PROXY_MAX_MANIFEST_BYTES) upstreamRes.destroy();
        else chunks.push(c);
      });
      upstreamRes.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const rewritten = rewritePlaylist(text, targetUrl.toString());
        res.writeHead(upstreamRes.statusCode, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        });
        res.end(rewritten);
      });
      upstreamRes.on('error', () => { try { res.destroy(); } catch (e) {} });
    } else {
      const passHeaders = { 'Access-Control-Allow-Origin': '*' };
      ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified'].forEach((h) => {
        if (upstreamRes.headers[h]) passHeaders[h] = upstreamRes.headers[h];
      });
      res.writeHead(upstreamRes.statusCode, passHeaders);
      upstreamRes.pipe(res);
    }
  });
}

function getLanIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch (_) { res.writeHead(400); return res.end('Bad request'); }

  // health check (parity กับแอปอื่นบน server)
  if (urlPath === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ status: 'ok', app: 'm3u8', ts: Date.now() }));
  }

  // ให้หน้าเว็บรู้ IP ของ LAN เพื่อสร้างลิงก์ /proxy ที่ทีวีเข้าถึงได้ โดยไม่ต้อง
  // บังคับให้ผู้ใช้เปิดหน้าเว็บผ่าน IP นั้นเอง — เปิดผ่าน localhost ได้ตามปกติ
  // (Google Cast SDK ต้องการ secure context ซึ่ง localhost ผ่าน แต่ IP เปล่าบน
  // http:// ไม่ผ่าน ปุ่ม CAST จะกดไม่ได้ถ้าบังคับเปิดด้วย IP ตรงๆ)
  if (urlPath === '/api/lan-ip') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ip: getLanIPv4(), port: PORT }));
  }

  if (urlPath === '/proxy') {
    const qIndex = req.url.indexOf('?');
    const qs = qIndex >= 0 ? new URLSearchParams(req.url.slice(qIndex + 1)) : new URLSearchParams();
    const target = qs.get('url');
    if (!target) { res.writeHead(400); return res.end('Missing url'); }
    handleProxy(req, res, target);
    return;
  }

  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // กัน path traversal
  const rel = path.normalize(urlPath).replace(/^([/\\]|\.\.([/\\]|$))+/g, '');
  if (isBlocked(rel)) { res.writeHead(404); return res.end('Not found'); }

  const filePath = path.join(ROOT, rel);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403); return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=604800',
    });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ▶ WePlay กำลังทำงานที่: http://localhost:' + PORT);
  console.log('  ▶ เปิดลิงก์นี้ใน Chrome เพื่อใช้งาน (ปุ่ม CAST ต้องเปิดผ่าน localhost ถึงจะกดได้)');
  const lan = getLanIPv4();
  if (lan) {
    console.log('  ▶ เครื่องนี้อยู่ที่ IP: ' + lan + ' (ใช้ภายใน /proxy ตอน Cast โดยอัตโนมัติ ไม่ต้องเปิดลิงก์นี้เอง)');
  }
  console.log('  ▶ กด Ctrl+C เพื่อหยุดเซิร์ฟเวอร์');
  console.log('');
});

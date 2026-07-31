// ═══════════════════════════════════════════════════════════
// WePlay — Node static server (zero-dependency)
// ใช้ได้ทั้ง LOCAL (double-click start-*) และ DEPLOY (หลัง nginx)
//   LOCAL  : start-windows.bat / start-mac-linux.command → PORT=8000
//   DEPLOY : run.sh อ่าน PORT จาก .env  (PRD=8009  DEV=8109)
// nginx: location /m3u8/ { proxy_pass http://127.0.0.1:<PORT>/; }
//        → prefix /m3u8/ ถูก strip ก่อนถึง server นี้ (เสิร์ฟจาก root)
// ไม่มี dependency ภายนอก ใช้แค่ Node core (http/fs/path)
// ═══════════════════════════════════════════════════════════
'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8000', 10);
const HOST = '127.0.0.1';          // เข้าถึงได้เฉพาะ localhost / nginx บนเครื่อง
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

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch (_) { res.writeHead(400); return res.end('Bad request'); }

  // health check (parity กับแอปอื่นบน server)
  if (urlPath === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ status: 'ok', app: 'm3u8', ts: Date.now() }));
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
  console.log('  ▶ เปิดลิงก์นี้ใน Chrome เพื่อใช้งาน (กด Ctrl+C เพื่อหยุด)');
  console.log('');
});

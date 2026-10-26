import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
const root = resolve(existsSync('dist/index.html') ? 'dist' : '.');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.wav': 'audio/wav',
};
createServer((req, res) => {
  try {
    const p = resolve(
      root,
      '.' +
        decodeURIComponent(
          new URL(req.url, 'http://localhost').pathname == '/'
            ? '/index.html'
            : new URL(req.url, 'http://localhost').pathname,
        ),
    );
    if (!p.startsWith(root + sep)) throw Error();
    res.setHeader('Content-Type', mime[extname(p)] || 'application/octet-stream');
    res.end(readFileSync(p));
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(8080, '127.0.0.1', () => console.log('http://127.0.0.1:8080'));

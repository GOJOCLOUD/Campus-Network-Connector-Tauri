/**
 * e2e 用的静态服务器：把工程根目录暴露给浏览器。
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, join, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.crdb': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export async function startServer(rootDir = ROOT) {
  const server = createServer((req, resp) => {
    const raw = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = normalize(raw === '/' ? '/index.html' : raw).replace(/^(\.\.[/\\])+/, '');
    const file = join(rootDir, rel);
    if (!file.startsWith(rootDir) || !existsSync(file) || statSync(file).isDirectory()) {
      resp.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      resp.end('not found');
      return;
    }
    resp.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    resp.end(readFileSync(file));
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  return {
    server,
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((res) => server.close(res)),
  };
}

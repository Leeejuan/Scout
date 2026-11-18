import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import handler from '../api/scout.js';

const assets = Object.freeze({
  '/': ['index.html', 'text/html'],
  '/scout.js': ['scout.js', 'text/javascript'],
  '/scout.css': ['scout.css', 'text/css']
});
const port = Number(process.env.SCOUT_LOCAL_PORT ?? 3000);
export const localServer = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://127.0.0.1');
  if (pathname === '/api/scout') return handler(req, res);
  if (!Object.hasOwn(assets, pathname) || req.method !== 'GET') {
    res.writeHead(404).end();
    return;
  }
  const [name, type] = assets[pathname];
  res.writeHead(200, { 'content-type': type + '; charset=utf-8' });
  res.end(await readFile(new URL('../public/' + name, import.meta.url)));
}).listen(port, '127.0.0.1', () => console.log('Scout http://127.0.0.1:' + port));

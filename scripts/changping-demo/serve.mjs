#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const directory = process.argv.includes('--atlas') ? 'changping-demo-v2-20261024' : 'changping-demo-20261024';
const output = fileURLToPath(new URL(`../../data/static/${directory}/`, import.meta.url));
const prefix = `/static/${directory}/`;
const types = {'.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8'};
const port = Number(process.argv[2] ?? 5679);
http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {response.writeHead(405).end(); return;}
  let pathname;
  try {pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);}
  catch {response.writeHead(400).end(); return;}
  if (pathname === '/') {response.writeHead(302, {Location: `${prefix}index.html`}).end(); return;}
  if (!pathname.startsWith(prefix)) {response.writeHead(404).end(); return;}
  const file = path.resolve(output, pathname.slice(prefix.length));
  if (!file.startsWith(output)) {response.writeHead(403).end(); return;}
  let stat;
  try {stat = fs.statSync(file); if (!stat.isFile()) throw Error('Not a file');}
  catch {response.writeHead(404).end(); return;}
  const headers = {'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache'};
  let start = 0, end = stat.size - 1, status = 200;
  if (request.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    if (!range || (!range[1] && !range[2])) {response.writeHead(416, {'Content-Range': `bytes */${stat.size}`}).end(); return;}
    start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
      response.writeHead(416, {'Content-Range': `bytes */${stat.size}`}).end(); return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  response.writeHead(status, {...headers, 'Content-Length': end - start + 1});
  if (request.method === 'HEAD') {response.end(); return;}
  const stream = fs.createReadStream(file, {start, end});
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}${prefix}index.html`));

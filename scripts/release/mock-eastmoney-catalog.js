#!/usr/bin/env node

const fs = require('fs');
const http = require('http');

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error(`Missing ${name}`);
  }
  return process.argv[index + 1];
}

const port = Number(argument('--port'));
const statePath = argument('--state');

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  const page = Number(url.searchParams.get('pn') || '1');
  const mode = fs.existsSync(statePath)
    ? fs.readFileSync(statePath, 'utf8').trim()
    : 'partial';
  if (page === 2 && mode !== 'complete') {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'intentional page two failure' }));
    return;
  }

  const symbol = page === 1 ? '600001' : '600002';
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    data: {
      total: 200,
      diff: [{
        f12: symbol,
        f13: 1,
        f14: `Smoke ${symbol}`,
        f100: 'fixture',
        f102: 'fixture',
        f103: 'fixture',
      }],
    },
  }));
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`eastmoney smoke mock listening on ${port}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

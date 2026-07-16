const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { safeStorage } = require('electron');

const MAX_BODY_BYTES = 64 * 1024;

function createSecretStore(baseDir) {
  const storePath = path.join(baseDir, 'secrets.bin');

  function readStore() {
    if (!fs.existsSync(storePath)) return {};
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows secure storage is unavailable. Secrets cannot be opened safely.');
    }
    const encrypted = Buffer.from(fs.readFileSync(storePath, 'utf8'), 'base64');
    return JSON.parse(safeStorage.decryptString(encrypted));
  }

  function writeStore(value) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows secure storage is unavailable. Secrets cannot be saved safely.');
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(value));
    const temporaryPath = `${storePath}.tmp`;
    fs.writeFileSync(temporaryPath, encrypted.toString('base64'), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, storePath);
  }

  return {
    put(value, existingReference) {
      const store = readStore();
      const reference = existingReference || `dpapi:${crypto.randomUUID()}`;
      store[reference] = String(value);
      writeStore(store);
      return reference;
    },
    get(reference) {
      if (!reference) return null;
      return readStore()[reference] ?? null;
    },
    delete(reference) {
      if (!reference) return;
      const store = readStore();
      delete store[reference];
      writeStore(store);
    },
  };
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function startSecretBroker({ baseDir, launchToken }) {
  const store = createSecretStore(baseDir);
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.headers['x-quantpilot-launch-token'] !== launchToken) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    try {
      const body = await readJsonBody(request);
      if (request.method === 'POST' && request.url === '/put') {
        const reference = store.put(body.value, body.reference);
        response.end(JSON.stringify({ reference }));
        return;
      }
      if (request.method === 'POST' && request.url === '/get') {
        response.end(JSON.stringify({ value: store.get(body.reference) }));
        return;
      }
      if (request.method === 'POST' && request.url === '/delete') {
        store.delete(body.reference);
        response.end(JSON.stringify({ deleted: true }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

module.exports = { startSecretBroker };

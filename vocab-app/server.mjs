import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { completeVocabulary, validateLookup, LookupError, DEFAULT_MODEL } from './deepseek.mjs';
import { assessWriting, validateWritingRequest } from './writing.mjs';
import { createDatabase, StorageError } from './database.mjs';
import { createSettingsStore } from './ai-settings.mjs';

const root = fileURLToPath(new URL('./dist/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

export async function loadConfig(envFile = new URL('../.env', import.meta.url), environment = process.env) {
  let contents = '';
  try { contents = await readFile(envFile, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read the local .env configuration.'); }
  const values = {};
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^\s*(DEEPSEEK_API_KEY|DEEPSEEK_MODEL|PORT)\s*=\s*(.*?)\s*$/u);
    if (!match) continue;
    let value = match[2];
    if (/^(["']).*\1$/u.test(value)) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return {
    apiKey: environment.DEEPSEEK_API_KEY ?? values.DEEPSEEK_API_KEY,
    model: environment.DEEPSEEK_MODEL || values.DEEPSEEK_MODEL || DEFAULT_MODEL,
    port: Number(environment.PORT || values.PORT || 4173),
  };
}

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(payload));
}

function readJson(request, limit = 4096) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    const timer = setTimeout(() => fail(new LookupError('The request took too long.', 408)), 10_000);
    function cleanup() { clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('error', fail); request.off('aborted', aborted); }
    function fail(error) { cleanup(); request.resume(); reject(error); }
    function aborted() { fail(new LookupError('Request stopped.', 400)); }
    function data(chunk) {
      size += chunk.length;
      if (size > limit) { fail(new LookupError('This request is too large.', 413)); return; }
      chunks.push(chunk);
    }
    function end() {
      cleanup();
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new LookupError('Send a valid JSON request.', 400)); }
    }
    request.on('data', data); request.on('end', end); request.on('error', fail); request.on('aborted', aborted);
  });
}

export function createAppServer({ apiKey, model = DEFAULT_MODEL, lookup = completeVocabulary, writingEvaluator = assessWriting, database = createDatabase() } = {}) {
  const cache = new Map();
  const settingsReady = createSettingsStore({ legacyKey: apiKey, legacyModel: model });
  let activeRequests = 0;
  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host;
      const address = server.address();
      const hosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
      if (!hosts.includes(host)) { json(response, 403, { error: 'Use the local Wordwell address.' }); return; }
      const pathname = decodeURIComponent(new URL(request.url, `http://${host}`).pathname);
      if (['/api/settings/ai', '/api/settings/ai/dismiss', '/api/settings/ai/models', '/api/settings/ai/key'].includes(pathname)) {
        if ((request.headers.origin && request.headers.origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') { json(response, 403, { error: 'Settings are only available from your local Wordwell page.' }); return; }
        const settings = await settingsReady;
        if (pathname === '/api/settings/ai' && request.method === 'GET') { json(response, 200, settings.publicState()); return; }
        if (pathname === '/api/settings/ai' && request.method === 'PUT' || ['/api/settings/ai/dismiss', '/api/settings/ai/models', '/api/settings/ai/key'].includes(pathname) && request.method === 'POST') {
          if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') { json(response, 415, { error: 'Use a JSON request.' }); return; }
          const payload = await readJson(request, 12 * 1024);
          if (pathname.endsWith('/key')) { json(response, 200, settings.revealKey(payload)); return; }
          if (pathname.endsWith('/models')) {
            const controller = new AbortController();
            response.on('close', () => controller.abort());
            const result = await settings.discover(payload, { signal: controller.signal });
            if (!controller.signal.aborted) json(response, 200, result);
            return;
          }
          const result = pathname.endsWith('/dismiss') ? await settings.dismiss(payload?.revision) : await settings.save(payload);
          cache.clear();
          json(response, 200, result);
          return;
        }
        json(response, 405, { error: 'This settings action is not available.' }); return;
      }
      if (pathname.startsWith('/api/storage/')) {
        if ((request.headers.origin && request.headers.origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') { json(response, 403, { error: 'Database access is only available from your local Wordwell page.' }); return; }
        const kind = pathname.slice('/api/storage/'.length);
        if (kind === 'backup' && request.method === 'GET') {
          const contents = await database.export();
          response.writeHead(200, { 'Content-Type': 'application/vnd.sqlite3', 'Content-Disposition': 'attachment; filename="wordwell.sqlite"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          response.end(contents);
          return;
        }
        if (['notebook', 'writing'].includes(kind) && request.method === 'GET') { json(response, 200, database.read(kind)); return; }
        if (['notebook', 'writing'].includes(kind) && request.method === 'PUT' || kind === 'migrate' && request.method === 'POST') {
          if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') { json(response, 415, { error: 'Use a JSON request.' }); return; }
          const payload = await readJson(request, kind === 'writing' ? 8 * 1024 * 1024 : 20 * 1024 * 1024);
          json(response, 200, kind === 'migrate' ? database.migrate(payload) : database.save(kind, payload));
          return;
        }
        json(response, ['notebook', 'writing', 'migrate', 'backup'].includes(kind) ? 405 : 404, { error: 'This database action is not available.' });
        return;
      }
      if (pathname === '/api/vocabulary/complete' || pathname === '/api/writing/assess') {
        const isWriting = pathname === '/api/writing/assess';
        if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); json(response, 405, { error: 'Use POST for AI requests.' }); return; }
        if ((request.headers.origin && request.headers.origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') { json(response, 403, { error: 'AI requests are only available from your local Wordwell page.' }); return; }
        if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') { json(response, 415, { error: 'Use a JSON request.' }); return; }
        const payload = await readJson(request, isWriting ? 3 * 1024 * 1024 : 4096);
        const writingInput = isWriting ? validateWritingRequest(payload) : null;
        const word = isWriting ? null : validateLookup(payload);
        const configuration = (await settingsReady).active();
        const key = isWriting ? null : `${configuration.revision}:${configuration.provider}:${configuration.model}:${word.normalize('NFKC').toLocaleLowerCase('en')}`;
        const cached = key ? cache.get(key) : null;
        if (cached && cached.expires > Date.now()) { json(response, 200, cached.entry); return; }
        if (activeRequests >= 2) { json(response, 429, { error: 'Other AI requests are running. Please try again shortly.' }); return; }
        const controller = new AbortController();
        response.on('close', () => controller.abort());
        activeRequests++;
        try {
          const entry = await (isWriting ? writingEvaluator(writingInput, { ...configuration, signal: controller.signal }) : lookup(word, { ...configuration, signal: controller.signal }));
          if (controller.signal.aborted) return;
          if (key) {
            if (cache.size >= 200) cache.delete(cache.keys().next().value);
            cache.set(key, { entry, expires: Date.now() + 30 * 60_000 });
          }
          json(response, 200, entry);
        } finally { activeRequests--; }
        return;
      }
      if (pathname.startsWith('/api/')) { json(response, 404, { error: 'This API route is not available. Restart Wordwell and refresh the page.' }); return; }
      if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD'); response.writeHead(405).end('Method not allowed'); return; }
      const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!target.startsWith(root.endsWith(sep) ? root : root + sep)) { response.writeHead(403).end('Forbidden'); return; }
      const contents = await readFile(target);
      response.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (error instanceof LookupError || error instanceof StorageError) json(response, error.status, { error: error.message });
      else if (error.code === 'ENOENT' || error.code === 'EISDIR') response.writeHead(404).end('Not found');
      else json(response, 500, { error: 'Wordwell could not process this request. Please try again.' });
    }
  });
  server.on('close', () => database.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = await loadConfig();
  createAppServer(config).listen(config.port, '127.0.0.1', () => {
    console.log(`Wordwell is ready at http://127.0.0.1:${config.port}`);
    console.log('Data is saved in data/wordwell.sqlite.');
    console.log('Choose or update your AI provider in Settings. Manual entry is always available.');
  }).on('error', error => {
    console.error(`Could not start Wordwell: ${error.message}`);
    process.exitCode = 1;
  });
}

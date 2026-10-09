import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../server.mjs';
import { createDatabase } from '../database.mjs';

async function startServer(t, { fixture = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wordwell-static-test-'));
  const staticRoot = fixture ? join(directory, 'public') : undefined;
  if (fixture) {
    await mkdir(staticRoot);
    await writeFile(join(staticRoot, 'index.html'), '<html>Public app</html>');
    await writeFile(join(staticRoot, 'private.js'), 'PRIVATE_FILE_SENTINEL');
    await writeFile(join(staticRoot, '.env'), 'PRIVATE_FILE_SENTINEL');
  }
  const server = createAppServer({ staticRoot, settingsPath: join(directory, 'ai-settings.json'), database: createDatabase(':memory:') });
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, directory, staticRoot };
}

// Use raw HTTP paths: fetch and browsers normalize dot segments before sending.
function rawRequest(url, path, method = 'GET') {
  const address = new URL(url);
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: address.hostname, port: address.port, path, method }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

test('all frontend files remain accessible with query strings and HEAD requests', async t => {
  const { url } = await startServer(t);
  for (const path of ['/', '/index.html', '/styles.css', '/app.js', '/autofill.js', '/notebook.js', '/review-session.js', '/persistence.js', '/settings.js', '/writing-data.js', '/writing.js', '/passage.js', '/passage-data.js', '/image-input.js']) {
    const response = await rawRequest(url, `${path}?v=1`);
    assert.equal(response.status, 200, path);
    assert.ok(response.body.length > 0, path);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    const head = await rawRequest(url, path, 'HEAD');
    assert.equal(head.status, 200, path);
    assert.equal(head.body, '', path);
    assert.equal(head.headers['content-type'], response.headers['content-type']);
  }
  assert.equal((await rawRequest(url, '/app.js?example=../../.env')).status, 200);
});

test('raw and encoded traversal paths cannot escape the frontend directory or reach API routes', async t => {
  const { url } = await startServer(t);
  const paths = [
    '/../.env', '/../../.env', '/%2e%2e/.env', '/%2E%2E%2F.env', '/..%2f..%2fdata/ai-settings.json',
    '/%2e%2e%5c.env', '/..\\.env', '/%5c..%5cdata%5cwordwell.sqlite', '/%252e%252e%252f.env',
    '/%252e%252e%255c.env', '/./app.js', '/%2e/app.js', '/app.js/../../.env',
    '/../api/settings/ai', '/%2e%2e%2fapi/storage/backup', '/%2f%2fserver/.env',
    '/C:%5cWindows%5cwin.ini', '/app.js:$DATA', '/app.js%3A%24DATA', '/%5c%5cserver%5cshare%5cfile',
  ];
  for (const path of paths) {
    const response = await rawRequest(url, path);
    assert.ok([400, 403].includes(response.status), `${path}: ${response.status}`);
    assert.ok(!response.body.includes('apiKey'), path);
  }
});

test('private files, directories, and unlisted files are never served as static assets', async t => {
  const { url } = await startServer(t, { fixture: true });
  for (const path of ['/.env', '/%2eenv', '/private.js', '/data/ai-settings.json', '/data/wordwell.sqlite', '/.git/config', '/server.mjs', '/ai-settings.mjs', '/README.md', '/package.json', '/app.js.', '/app.js/', '/public/']) {
    const response = await rawRequest(url, path);
    assert.equal(response.status, 404, path);
    assert.ok(!response.body.includes('PRIVATE_FILE_SENTINEL'), path);
  }
});

test('malformed URL encoding and non-local request targets return controlled client errors', async t => {
  const { url } = await startServer(t);
  for (const path of ['/bad%ZZ', '/%', '/%C0%AE%C0%AE/.env', '/app.js%00', '/app.js%0a', '//example.com/app.js', 'http://example.com/app.js']) {
    const response = await rawRequest(url, path);
    assert.equal(response.status, 400, path);
    assert.match(response.headers['content-type'], /application\/json/);
    assert.ok(!response.body.includes('E:\\'), path);
  }
});

test('an allowed asset cannot follow a filesystem link outside the public directory', async t => {
  const { url, directory, staticRoot } = await startServer(t, { fixture: true });
  const outside = join(directory, 'private');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'PRIVATE_FILE_SENTINEL');
  // Windows junctions do not require symlink privileges; both types resolve
  // outside the public root and must be rejected before any file is read.
  const target = process.platform === 'win32' ? outside : join(outside, 'secret.txt');
  await symlink(target, join(staticRoot, 'app.js'), process.platform === 'win32' ? 'junction' : 'file');
  const response = await rawRequest(url, '/app.js');
  assert.equal(response.status, 403);
  assert.ok(!response.body.includes('PRIVATE_FILE_SENTINEL'));
});

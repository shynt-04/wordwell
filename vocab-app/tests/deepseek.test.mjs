import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeVocabulary, validateLookup, validateCompletion } from '../deepseek.mjs';
import { createAppServer, loadConfig } from '../server.mjs';
import { createDatabase } from '../database.mjs';

const entry = { meaning: 'Convincing or interesting.\n-> Thuyết phục, hấp dẫn', pronunciation: '/kəmˈpelɪŋ/', synonyms: 'convincing, persuasive', example: 'She presented a compelling argument for better public transport.' };
const completion = (value = entry, finish_reason = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason, message: { content: JSON.stringify(value) } }] }), { status: 200 });

test('DeepSeek request sends only the word with JSON output and server authentication', async () => {
  let request;
  const result = await completeVocabulary(' compelling ', { apiKey: 'test-key', fetchImpl: async (url, options) => { request = { url, options }; return completion(); } });
  assert.deepEqual(result, entry);
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(request.options.body);
  assert.deepEqual(JSON.parse(body.messages[1].content), { word: 'compelling' });
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.thinking.type, 'disabled');
  assert.equal(body.max_tokens, 600);
});

test('generated meanings preserve Vietnamese diacritics and line breaks, and reject missing translations', () => {
  const bilingual = { ...entry, meaning: 'Living or occurring at the same time.\n-> Đương thời' };
  assert.equal(validateCompletion(bilingual).meaning, bilingual.meaning);
  assert.throws(() => validateCompletion({ ...entry, meaning: 'Living or occurring at the same time.' }), /Vietnamese translation/);
  assert.throws(() => validateCompletion({ ...entry, meaning: 'Living or occurring at the same time.\n-> ' }), /Vietnamese translation/);
});

test('AI synonyms must be a bounded string, including an honest no-synonym result', () => {
  assert.throws(() => validateCompletion({ ...entry, synonyms: undefined }), /incomplete/);
  assert.throws(() => validateCompletion({ ...entry, synonyms: ['persuasive'] }), /incomplete/);
  assert.throws(() => validateCompletion({ ...entry, synonyms: 'x'.repeat(501) }), /incomplete/);
  assert.equal(validateCompletion({ ...entry, synonyms: 'No close synonyms.' }).synonyms, 'No close synonyms.');
});

test('lookup rejects private note payloads, control characters, and oversized input', () => {
  assert.throws(() => validateLookup({ word: 'compelling', note: 'Private note' }));
  assert.throws(() => validateLookup({ word: 'line\nbreak' }));
  assert.throws(() => validateLookup({ word: 'x'.repeat(121) }));
  assert.throws(() => validateLookup({ word: '12345' }));
  assert.equal(validateLookup({ word: ' in the long run ' }), 'in the long run');
});

test('incomplete, unrecognised, and truncated AI results do not become suggestions', async () => {
  assert.throws(() => validateCompletion({ ...entry, pronunciation: '' }));
  assert.throws(() => validateCompletion({ error: 'not_vocabulary' }), error => error.status === 422);
  await assert.rejects(completeVocabulary('compelling', { apiKey: 'test-key', fetchImpl: async () => completion(entry, 'length') }), /did not finish/);
  await assert.rejects(completeVocabulary('compelling', { apiKey: 'test-key', fetchImpl: async () => new Response('invalid JSON') }), /unreadable response/);
  await assert.rejects(completeVocabulary('compelling', { apiKey: 'test-key', fetchImpl: async () => completion({ meaning: 'Only one field' }) }), /incomplete/);
});

test('upstream failures show useful messages without exposing provider responses or keys', async () => {
  for (const [status, text] of [[401, 'rejected'], [402, 'balance'], [429, 'limit'], [500, 'unavailable']]) {
    await assert.rejects(completeVocabulary('compelling', { apiKey: 'test-key', fetchImpl: async () => new Response('secret-provider-detail', { status }) }), error => error.message.includes(text) && !error.message.includes('test-key') && !error.message.includes('secret-provider-detail'));
  }
  await assert.rejects(completeVocabulary('compelling', { fetchImpl: async () => { throw new Error('should not call'); } }), /not configured/);
});

test('cancelling autofill aborts the upstream call', async () => {
  const controller = new AbortController();
  const pending = completeVocabulary('compelling', { apiKey: 'test-key', signal: controller.signal, fetchImpl: (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })) });
  controller.abort();
  await assert.rejects(pending, /stopped/);
});

test('environment configuration overrides the local file without requiring it', async () => {
  const config = await loadConfig(new URL('./missing-test-config.env', import.meta.url), { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_MODEL: 'test-model', PORT: '4567' });
  assert.equal(config.apiKey, 'test-key');
  assert.equal(config.model, 'test-model');
  assert.equal(config.port, 4567);
});

async function startServer(t, options) {
  const directory = await mkdtemp(join(tmpdir(), 'wordwell-server-test-'));
  const server = createAppServer({ ...options, settingsPath: join(directory, 'ai-settings.json'), database: createDatabase(':memory:') });
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, endpoint: `${url}/api/vocabulary/complete` };
}

test('API key revealing requires an explicit true setting and environment overrides the env file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wordwell-config-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, '.env');
  await writeFile(envFile, 'ENABLE_API_KEY_REVEAL="true"\n');
  assert.equal((await loadConfig(envFile, {})).allowKeyReveal, true);
  for (const value of ['false', '', '1', 'yes']) {
    assert.equal((await loadConfig(envFile, { ENABLE_API_KEY_REVEAL: value })).allowKeyReveal, false);
  }
  await writeFile(envFile, 'PORT=4173\n');
  assert.equal((await loadConfig(envFile, {})).allowKeyReveal, false);
  assert.equal((await loadConfig(envFile, { ENABLE_API_KEY_REVEAL: ' TRUE ' })).allowKeyReveal, true);
});

test('key reveal is blocked by default while saved credentials still power AI requests', async t => {
  const { url, endpoint } = await startServer(t, { apiKey: 'test-key', lookup: async (word, options) => {
    assert.equal(options.apiKey, 'test-key');
    return entry;
  } });
  const state = await (await fetch(`${url}/api/settings/ai`)).json();
  assert.equal(state.allowKeyReveal, false);
  assert.equal(state.profiles.deepseek.hasKey, true);
  assert.ok(!JSON.stringify(state).includes('test-key'));
  for (const payload of [{ revision: state.revision, provider: 'deepseek' }, { allowKeyReveal: true, provider: 'deepseek' }]) {
    const response = await fetch(`${url}/api/settings/ai/key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(payload),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'API key revealing is disabled.' });
  }
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ word: 'compelling' }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), entry);
});

test('explicitly enabling key reveal allows local requests and preserves origin and revision checks', async t => {
  const { url } = await startServer(t, { apiKey: 'test-key', allowKeyReveal: true });
  const state = await (await fetch(`${url}/api/settings/ai`)).json();
  assert.equal(state.allowKeyReveal, true);
  assert.ok(!JSON.stringify(state).includes('test-key'));
  const reveal = (revision, origin = url) => fetch(`${url}/api/settings/ai/key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ revision, provider: 'deepseek' }),
  });
  assert.equal((await reveal(state.revision, 'https://other.example')).status, 403);
  assert.equal((await reveal(state.revision + 1)).status, 409);
  const response = await reveal(state.revision);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { apiKey: 'test-key' });
});

test('local API completes a word, caches repeats, and does not serve the env file', async t => {
  let calls = 0;
  const { url, endpoint } = await startServer(t, { apiKey: 'test-key', lookup: async () => { calls++; return entry; } });
  for (const word of ['compelling', 'COMPELLING']) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ word }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), entry);
  }
  assert.equal(calls, 1);
  assert.equal((await fetch(`${url}/.env`)).status, 404);
  assert.equal((await fetch(`${url}/deepseek.mjs`)).status, 404);
  const staticResponse = await fetch(url);
  assert.equal(staticResponse.status, 200);
  assert.ok(!(await staticResponse.text()).includes('test-key'));
});

test('local API rejects foreign origins and non-JSON or invalid requests before calling DeepSeek', async t => {
  let calls = 0;
  const { endpoint } = await startServer(t, { apiKey: 'test-key', lookup: async () => { calls++; return entry; } });
  assert.equal((await fetch(endpoint)).status, 405);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' }, body: '{"word":"compelling"}' })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', body: '{"word":"compelling"}' })).status, 415);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' })).status, 400);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ word: 'x'.repeat(5000) }) })).status, 413);
  assert.equal(calls, 0);
  const missing = await fetch(endpoint + '/missing', { method: 'POST' });
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /application\/json/);
  assert.match((await missing.json()).error, /Restart Wordwell/);
});

test('local API reports missing configuration and redacts unexpected internal failures', async t => {
  const missing = await startServer(t, {});
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"word":"compelling"}' };
  assert.equal((await fetch(missing.endpoint, options)).status, 503);
  const broken = await startServer(t, { apiKey: 'test-key', lookup: async () => { throw new Error('secret-provider-detail'); } });
  const response = await fetch(broken.endpoint, options);
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes('secret-provider-detail'));
});

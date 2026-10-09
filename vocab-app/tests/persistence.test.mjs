import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotebookStore } from '../dist/persistence.js';
import { STORAGE_KEY, createWord, emptyNotebook, validateNotebook } from '../dist/notebook.js';

function browserStorage(t, raw) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => key === STORAGE_KEY ? raw : null } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; });
}

const response = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('browser migration sends original v1 data so previous migration fingerprints remain valid', async t => {
  const { production, ...word } = createWord({ word: 'compelling', meaning: 'Convincing' }, 1_800_000_000_000);
  const legacy = { version: 1, words: [word], reviews: [] };
  browserStorage(t, JSON.stringify(legacy));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return response(url.endsWith('/migrate') ? { revision: 1, notebook: validateNotebook(legacy) } : { revision: 0, notebook: emptyNotebook() });
  });
  const store = createNotebookStore();
  assert.deepEqual(await store.read(), validateNotebook(legacy));
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].options.body), { kind: 'notebook', value: legacy });
  assert.equal(localStorage.getItem(STORAGE_KEY), JSON.stringify(legacy));
  assert.equal(store.migrationWarning, '');
});

for (const [label, raw] of [['unparseable', '{broken'], ['invalid', '{"version":1,"words":"invalid","reviews":[]}']]) {
  test(`${label} retained browser data is preserved and does not block the valid SQLite notebook`, async t => {
    browserStorage(t, raw);
    const calls = [];
    t.mock.method(globalThis, 'fetch', async url => { calls.push(url); return response({ revision: 3, notebook: emptyNotebook() }); });
    const store = createNotebookStore();
    assert.deepEqual(await store.read(), emptyNotebook());
    assert.match(store.migrationWarning, /preserved/);
    assert.equal(calls.length, 1);
    assert.equal(localStorage.getItem(STORAGE_KEY), raw);
  });
}

test('v2 notebook saves retain their schema and use the current server revision', async t => {
  browserStorage(t, null);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return response(options?.method === 'PUT' ? { revision: 8 } : { revision: 7, notebook: emptyNotebook() });
  });
  const store = createNotebookStore();
  await store.read();
  const value = { version: 2, words: [createWord({ word: 'mitigate', meaning: 'Make less serious' })], reviews: [] };
  await store.save(value);
  assert.deepEqual(JSON.parse(calls[1].options.body), { revision: 7, value });
  await store.save(value);
  assert.equal(JSON.parse(calls[2].options.body).revision, 8);
});

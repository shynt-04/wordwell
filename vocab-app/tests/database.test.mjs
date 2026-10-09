import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createDatabase } from '../database.mjs';
import { createWord, scheduleWord, emptyNotebook, validateNotebook } from '../dist/notebook.js';
import { blankWritingDraft } from '../dist/writing-data.js';
import { createAppServer } from '../server.mjs';

const now = 1_800_000_000_000;
const makeWord = () => createWord({ word: 'compelling', meaning: 'Interesting or convincing' }, now);
const log = (word, direction) => ({ id: `review-${direction}`, wordId: word.id, rating: 'good', at: now, direction });

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'wordwell-database-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function legacyNotebook() {
  const { production, ...word } = scheduleWord(makeWord(), 'easy', now);
  const { direction, ...review } = log(word, 'meaning');
  return { version: 1, words: [word], reviews: [review] };
}

function seedLegacy(path, notebook, { alreadyMigrated = false } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE words (id TEXT PRIMARY KEY, word TEXT, meaning TEXT, pronunciation TEXT, synonyms TEXT, example TEXT, note TEXT,
      createdAt INTEGER, updatedAt INTEGER, dueAt INTEGER, interval REAL, repetitions INTEGER, lapses INTEGER, lastReviewedAt INTEGER);
    CREATE TABLE reviews (id TEXT PRIMARY KEY, wordId TEXT, rating TEXT, at INTEGER);
    CREATE TABLE storage_meta (kind TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    INSERT INTO storage_meta VALUES ('notebook', 3), ('writing', 2);
    CREATE TABLE writing_drafts (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL);
    CREATE TABLE browser_migrations (fingerprint TEXT PRIMARY KEY, kind TEXT NOT NULL, migratedAt INTEGER NOT NULL);
    PRAGMA user_version = 1;
  `);
  if (!alreadyMigrated) {
    const word = notebook.words[0];
    const columns = Object.keys(word);
    db.prepare(`INSERT INTO words (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(word));
    const review = notebook.reviews[0];
    db.prepare('INSERT INTO reviews VALUES (?, ?, ?, ?)').run(review.id, review.wordId, review.rating, review.at);
  } else {
    // The original validator canonicalized key order before hashing.
    const clean = validateNotebook(notebook);
    const value = { version: 1, words: clean.words.map(({ production, ...word }) => word), reviews: clean.reviews.map(({ direction, ...review }) => review) };
    const fingerprint = createHash('sha256').update('notebook' + JSON.stringify(value)).digest('hex');
    db.prepare('INSERT INTO browser_migrations VALUES (?, ?, ?)').run(fingerprint, 'notebook', now);
  }
  const draft = { ...blankWritingDraft(), essay: 'Keep my original writing draft.', updatedAt: now };
  db.prepare('INSERT INTO writing_drafts VALUES (1, ?)').run(JSON.stringify(draft));
  db.close();
  return draft;
}

test('SQLite upgrades preserve legacy vocabulary, review history, revisions, and Writing', async t => {
  const path = join(await directory(t), 'legacy.sqlite');
  const legacy = legacyNotebook();
  const draft = seedLegacy(path, legacy);
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = createDatabase(path);
    try {
      const saved = db.read('notebook');
      assert.equal(saved.revision, 3);
      assert.deepEqual(saved.notebook, validateNotebook(legacy));
      assert.equal(saved.notebook.words[0].production.lastReviewedAt, null);
      assert.equal(saved.notebook.words[0].dueAt, legacy.words[0].dueAt);
      assert.equal(saved.notebook.reviews[0].direction, 'meaning');
      assert.deepEqual(db.read('writing'), { revision: 2, draft });
    } finally { db.close(); }
  }
});

test('retained v1 browser data already migrated before an upgrade cannot resurrect deleted words', async t => {
  const path = join(await directory(t), 'deleted.sqlite');
  const legacy = legacyNotebook();
  seedLegacy(path, legacy, { alreadyMigrated: true });
  const db = createDatabase(path);
  try {
    const result = db.migrate({ kind: 'notebook', value: legacy });
    assert.equal(result.migrated, false);
    assert.equal(result.revision, 3);
    assert.deepEqual(result.notebook, emptyNotebook());
  } finally { db.close(); }
});

test('both-direction progress survives saving, restarting, and exporting a SQLite backup', async t => {
  const path = await directory(t);
  const original = scheduleWord(scheduleWord(makeWord(), 'easy', now), 'good', now + 100, 'word');
  const value = { version: 2, words: [original], reviews: [log(original, 'meaning'), log(original, 'word')] };
  const db = createDatabase(join(path, 'original.sqlite'));
  try {
    db.save('notebook', { revision: 0, value });
    assert.deepEqual(db.read('notebook'), { revision: 1, notebook: value });
    await writeFile(join(path, 'backup.sqlite'), await db.export());
  } finally { db.close(); }
  for (const name of ['original.sqlite', 'backup.sqlite']) {
    const reopened = createDatabase(join(path, name));
    try { assert.deepEqual(reopened.read('notebook'), { revision: 1, notebook: value }); }
    finally { reopened.close(); }
  }
});

test('stale tabs and v1 clients cannot overwrite independently saved progress', () => {
  const db = createDatabase(':memory:');
  try {
    const item = scheduleWord(makeWord(), 'good', now, 'word');
    const value = { version: 2, words: [item], reviews: [log(item, 'word')] };
    db.save('notebook', { revision: 0, value });
    assert.throws(() => db.save('notebook', { revision: 0, value: emptyNotebook() }), error => error.status === 409);
    assert.throws(() => db.save('notebook', { revision: 1, value: legacyNotebook() }), /Refresh before saving/);
    assert.deepEqual(db.read('notebook').notebook, value);
  } finally { db.close(); }
});

test('legacy browser migration remains idempotent and keeps newer progress in both directions', () => {
  const db = createDatabase(':memory:');
  try {
    const legacy = legacyNotebook();
    const item = scheduleWord(scheduleWord({ ...legacy.words[0], production: makeWord().production }, 'good', now + 100), 'good', now + 200, 'word');
    const current = { version: 2, words: [item], reviews: [log(item, 'word')] };
    db.save('notebook', { revision: 0, value: current });
    assert.equal(db.migrate({ kind: 'notebook', value: legacy }).migrated, true);
    assert.equal(db.migrate({ kind: 'notebook', value: legacy }).migrated, false);
    const saved = db.read('notebook').notebook;
    assert.deepEqual(saved.words[0], item);
    assert.equal(saved.reviews.length, 2);
  } finally { db.close(); }
});

test('future SQLite schemas are rejected without downgrading their version', async t => {
  const path = join(await directory(t), 'future.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version = 3'); db.close();
  assert.throws(() => createDatabase(path), /newer version/);
  const reopened = new DatabaseSync(path);
  try { assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 3); }
  finally { reopened.close(); }
});

test('the storage API persists v2 review directions and rejects invalid or downgraded saves', async t => {
  const settingsPath = join(await directory(t), 'ai-settings.json');
  const server = createAppServer({ settingsPath, database: createDatabase(':memory:') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const item = scheduleWord(makeWord(), 'good', now, 'word');
  const value = { version: 2, words: [item], reviews: [log(item, 'word')] };
  const put = payload => fetch(`${url}/api/storage/notebook`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(payload) });
  assert.equal((await put({ revision: 0, value })).status, 200);
  assert.equal((await put({ revision: 1, value: { ...value, reviews: [{ ...value.reviews[0], direction: 'invalid' }] } })).status, 400);
  assert.equal((await put({ revision: 1, value: legacyNotebook() })).status, 409);
  const saved = await (await fetch(`${url}/api/storage/notebook`)).json();
  assert.deepEqual(saved, { revision: 1, notebook: value });
});

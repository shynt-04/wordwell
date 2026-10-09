import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateNotebook, mergeNotebooks } from './dist/notebook.js';
import { validateWritingDraft } from './dist/writing-data.js';

export const DATABASE_PATH = fileURLToPath(new URL('../data/wordwell.sqlite', import.meta.url));

export class StorageError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const wordColumns = ['id', 'word', 'meaning', 'pronunciation', 'synonyms', 'example', 'note', 'createdAt', 'updatedAt', 'dueAt', 'interval', 'repetitions', 'lapses', 'lastReviewedAt'];

function clean(kind, value) {
  try {
    if (kind === 'notebook') return validateNotebook(value);
    const draft = validateWritingDraft(value);
    if (!Number.isSafeInteger(draft.updatedAt) || draft.updatedAt < 0) throw new Error('Invalid Writing draft date.');
    // Persist only application fields, never unexpected properties or credentials.
    return Object.fromEntries(['version', 'task', 'question', 'essay', 'image', 'imageName', 'feedbackLanguage', 'assessment', 'assessedInput', 'updatedAt'].map(key => [key, draft[key]]));
  } catch (error) { throw new StorageError(error.message); }
}

export function createDatabase(path = DATABASE_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (db.prepare('PRAGMA user_version').get().user_version > 2) { db.close(); throw new StorageError('This database needs a newer version of Wordwell.'); }
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS storage_meta (kind TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO storage_meta VALUES ('notebook', 0), ('writing', 0);
    CREATE TABLE IF NOT EXISTS words (
      id TEXT PRIMARY KEY, word TEXT NOT NULL, meaning TEXT NOT NULL,
      pronunciation TEXT NOT NULL, synonyms TEXT NOT NULL, example TEXT NOT NULL, note TEXT NOT NULL,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, dueAt INTEGER NOT NULL,
      interval REAL NOT NULL, repetitions INTEGER NOT NULL, lapses INTEGER NOT NULL, lastReviewedAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, wordId TEXT NOT NULL, rating TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS words_due ON words(dueAt);
    CREATE INDEX IF NOT EXISTS reviews_at ON reviews(at);
    CREATE TABLE IF NOT EXISTS writing_drafts (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS browser_migrations (fingerprint TEXT PRIMARY KEY, kind TEXT NOT NULL, migratedAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS writing_archive (fingerprint TEXT PRIMARY KEY, payload TEXT NOT NULL, archivedAt INTEGER NOT NULL);
  `);
  const revision = kind => db.prepare('SELECT revision FROM storage_meta WHERE kind = ?').get(kind).revision;
  const transaction = run => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = run(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  // Upgrade in place without rewriting words, history, drafts, or migration records.
  transaction(() => {
    if (!db.prepare('PRAGMA table_info(words)').all().some(column => column.name === 'production')) db.exec('ALTER TABLE words ADD COLUMN production TEXT');
    if (!db.prepare('PRAGMA table_info(reviews)').all().some(column => column.name === 'direction')) db.exec("ALTER TABLE reviews ADD COLUMN direction TEXT NOT NULL DEFAULT 'meaning'");
    db.exec('PRAGMA user_version = 2');
  });
  function read(kind) {
    if (kind === 'notebook') return { revision: revision(kind), notebook: validateNotebook({ version: 1, words: db.prepare(`SELECT ${wordColumns.join(', ')}, production FROM words ORDER BY rowid`).all().map(({ production, ...word }) => ({ ...word, ...(production !== null ? { production: JSON.parse(production) } : {}) })), reviews: db.prepare('SELECT id, wordId, rating, at, direction FROM reviews ORDER BY rowid').all() }) };
    const row = db.prepare('SELECT payload FROM writing_drafts WHERE id = 1').get();
    return { revision: revision(kind), draft: row ? validateWritingDraft(JSON.parse(row.payload)) : null };
  }
  function write(kind, value) {
    if (kind === 'notebook') {
      db.exec('DELETE FROM words; DELETE FROM reviews;');
      const insertWord = db.prepare(`INSERT INTO words (${wordColumns.join(', ')}, production) VALUES (${[...wordColumns, 'production'].map(() => '?').join(', ')})`);
      for (const word of value.words) insertWord.run(...wordColumns.map(key => word[key]), JSON.stringify(word.production));
      const insertReview = db.prepare('INSERT INTO reviews (id, wordId, rating, at, direction) VALUES (?, ?, ?, ?, ?)');
      for (const review of value.reviews) insertReview.run(review.id, review.wordId, review.rating, review.at, review.direction);
    } else db.prepare('INSERT INTO writing_drafts (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload').run(JSON.stringify(value));
    db.prepare('UPDATE storage_meta SET revision = revision + 1 WHERE kind = ?').run(kind);
  }
  return {
    path,
    read,
    save(kind, payload) {
      if (!payload || !Number.isSafeInteger(payload.revision) || payload.revision < 0) throw new StorageError('Refresh Wordwell before saving.');
      if (kind === 'notebook' && payload.value?.version === 1) throw new StorageError('Wordwell has been upgraded. Refresh before saving to preserve both review directions.', 409);
      const value = clean(kind, payload.value);
      return transaction(() => {
        if (payload.revision !== revision(kind)) throw new StorageError('The database changed in another tab. Refresh to load the latest data before saving; your edit has not replaced it.', 409);
        write(kind, value);
        return { revision: revision(kind) };
      });
    },
    migrate(payload) {
      if (!payload || !['notebook', 'writing'].includes(payload.kind)) throw new StorageError('Choose a valid browser migration.');
      const value = clean(payload.kind, payload.value);
      // Match fingerprints recorded before the v2 upgrade. Retained browser data
      // must not be imported twice and resurrect vocabulary the user deleted.
      const fingerprintValue = payload.kind === 'notebook' && payload.value.version === 1
        ? { version: 1, words: value.words.map(({ production, ...word }) => word), reviews: value.reviews.map(({ direction, ...review }) => review) }
        : value;
      const fingerprint = createHash('sha256').update(payload.kind + JSON.stringify(fingerprintValue)).digest('hex');
      return transaction(() => {
        if (db.prepare('SELECT fingerprint FROM browser_migrations WHERE fingerprint = ?').get(fingerprint)) return { ...read(payload.kind), migrated: false };
        const current = read(payload.kind);
        let archived = false;
        if (payload.kind === 'notebook') write('notebook', mergeNotebooks(current.notebook, value).notebook);
        else if (!current.draft) write('writing', value);
        else {
          // A different browser's old draft must not replace the current SQLite draft.
          db.prepare('INSERT OR IGNORE INTO writing_archive VALUES (?, ?, ?)').run(fingerprint, JSON.stringify(value), Date.now());
          archived = true;
        }
        db.prepare('INSERT INTO browser_migrations VALUES (?, ?, ?)').run(fingerprint, payload.kind, Date.now());
        return { ...read(payload.kind), migrated: true, archived };
      });
    },
    async export() {
      const directory = await mkdtemp(join(tmpdir(), 'wordwell-backup-'));
      const destination = join(directory, 'wordwell.sqlite');
      try {
        await backup(db, destination);
        return await readFile(destination);
      } finally {
        await unlink(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await rmdir(directory);
      }
    },
    close: () => db.close(),
  };
}

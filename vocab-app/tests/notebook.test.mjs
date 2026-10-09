import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, STORAGE_KEY, createWord, cleanFields, scheduleWord, nextInterval, reviewProgress, localDate, practiceStreak, emptyNotebook, validateNotebook, mergeNotebooks, loadNotebook, saveNotebook } from '../dist/notebook.js';

const now = new Date(2026, 9, 7, 12).getTime();
const makeWord = (word = 'compelling') => createWord({ word, meaning: 'Interesting or convincing', example: 'A compelling argument.' }, now);
const review = (word, at, rating = 'good') => ({ id: crypto.randomUUID(), wordId: word.id, at, rating, direction: 'meaning' });

test('new words are trimmed and immediately due; empty meanings are rejected', () => {
  const word = createWord({ word: ' compelling ', meaning: ' convincing ' }, now);
  assert.equal(word.word, 'compelling');
  assert.equal(word.meaning, 'convincing');
  assert.equal(word.dueAt, now);
  assert.equal(word.note, '');
  assert.throws(() => cleanFields({ word: 'compelling', meaning: '   ' }));
  assert.throws(() => cleanFields({ word: 'x'.repeat(121), meaning: 'Meaning' }));
});

test('successful recall grows intervals across saved sessions', () => {
  const first = scheduleWord(makeWord(), 'good', now);
  const second = scheduleWord(first, 'good', first.dueAt);
  const third = scheduleWord(second, 'good', second.dueAt);
  assert.deepEqual([first.interval, second.interval, third.interval], [1, 3, 8]);
  assert.equal(first.dueAt, now + DAY);
  assert.equal(third.repetitions, 3);
  assert.equal(third.lastReviewedAt, second.dueAt);
});

test('Again resets recall and schedules one minute later without mutating the original', () => {
  const original = scheduleWord(makeWord(), 'easy', now);
  const missed = scheduleWord(original, 'again', now + DAY);
  assert.equal(missed.dueAt, now + DAY + 60_000);
  assert.equal(missed.repetitions, 0);
  assert.equal(missed.lapses, 1);
  assert.equal(original.repetitions, 1);
  assert.equal(scheduleWord(missed, 'good', missed.dueAt).interval, 1);
});

test('Hard and Easy show the same intervals used by the scheduler', () => {
  const word = makeWord();
  assert.equal(nextInterval(word, 'hard'), 1);
  assert.equal(nextInterval(word, 'easy'), 4);
  for (const rating of ['hard', 'easy']) assert.equal(scheduleWord(word, rating, now).dueAt, now + nextInterval(word, rating) * DAY);
  assert.throws(() => scheduleWord(word, 'unknown', now));
});

test('streak uses local calendar days and retains yesterday’s streak', () => {
  const word = makeWord();
  const yesterday = new Date(2026, 9, 6, 12).getTime();
  const dayBefore = new Date(2026, 9, 5, 12).getTime();
  const log = [review(word, yesterday), review(word, yesterday), review(word, dayBefore)];
  assert.equal(practiceStreak(log, now), 2);
  assert.equal(practiceStreak([...log, review(word, now)], now), 3);
  assert.equal(practiceStreak([review(word, dayBefore)], now), 0);
  assert.equal(localDate(now), '2026-10-07');
});

test('storage round trip retains words, notes, and scheduled review history', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  assert.deepEqual(loadNotebook(storage), emptyNotebook());
  const word = scheduleWord(makeWord(), 'good', now);
  const notebook = { version: 2, words: [word], reviews: [review(word, now)] };
  saveNotebook(storage, notebook);
  assert.deepEqual(loadNotebook(storage), notebook);
  data.set(STORAGE_KEY, '{broken');
  assert.throws(() => loadNotebook(storage));
  assert.equal(data.get(STORAGE_KEY), '{broken');
});

test('older notebooks load without synonyms and newer backups preserve added synonyms and schedules', () => {
  const word = scheduleWord(makeWord(), 'good', now);
  const { synonyms, production, ...legacyWord } = word;
  const { direction, ...legacyReview } = review(word, now);
  const legacy = { version: 1, words: [legacyWord], reviews: [legacyReview] };
  const data = new Map([[STORAGE_KEY, JSON.stringify(legacy)]]);
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const loaded = loadNotebook(storage);
  assert.equal(loaded.words[0].synonyms, '');
  assert.equal(loaded.words[0].dueAt, word.dueAt);
  assert.equal(loaded.words[0].repetitions, word.repetitions);
  assert.equal(loaded.version, 2);
  assert.equal(loaded.words[0].production.dueAt, word.createdAt);
  assert.equal(loaded.words[0].production.lastReviewedAt, null);
  assert.equal(JSON.parse(data.get(STORAGE_KEY)).words[0].synonyms, undefined);
  loaded.words[0].synonyms = 'convincing, persuasive';
  saveNotebook(storage, loaded);
  const restored = validateNotebook(JSON.parse(data.get(STORAGE_KEY)));
  assert.equal(restored.words[0].synonyms, 'convincing, persuasive');
  assert.equal(restored.words[0].dueAt, word.dueAt);
  assert.deepEqual(restored.reviews, legacy.reviews.map(review => ({ ...review, direction: 'meaning' })));
});

test('invalid backups are rejected, including bad schedules, duplicate names, and duplicate IDs', () => {
  const word = makeWord();
  assert.throws(() => validateNotebook({ version: 3, words: [], reviews: [] }));
  assert.throws(() => validateNotebook({ version: 1, words: [{ ...word, dueAt: -1 }], reviews: [] }));
  assert.throws(() => validateNotebook({ version: 1, words: [{ ...word, dueAt: Number.MAX_SAFE_INTEGER }], reviews: [] }));
  assert.throws(() => validateNotebook({ version: 1, words: [word, { ...word }], reviews: [] }));
  assert.throws(() => validateNotebook({ version: 1, words: [word, makeWord('COMPELLING')], reviews: [] }));
  assert.throws(() => validateNotebook({ version: 1, words: [word], reviews: [{ ...review(word, now), rating: 'wrong' }] }));
});

test('combining backups retains newer schedules, adds missing words, and deduplicates review history', () => {
  const word = makeWord();
  const newer = scheduleWord(word, 'easy', now + DAY);
  const log = review(word, now + DAY, 'easy');
  const current = { version: 1, words: [newer], reviews: [log] };
  const extra = makeWord('mitigate');
  const incoming = { version: 1, words: [word, extra], reviews: [log] };
  const result = mergeNotebooks(current, incoming);
  assert.equal(result.added, 1);
  assert.equal(result.notebook.words.length, 2);
  assert.equal(result.notebook.words[0].dueAt, newer.dueAt);
  assert.equal(result.notebook.reviews.length, 1);
  assert.equal(current.words.length, 1);
});

test('same vocabulary from another device merges by name and remaps review references', () => {
  const word = makeWord();
  const incomingWord = scheduleWord(makeWord('COMPELLING'), 'good', now + DAY);
  const result = mergeNotebooks({ version: 1, words: [word], reviews: [] }, { version: 1, words: [incomingWord], reviews: [review(incomingWord, now + DAY)] });
  assert.equal(result.added, 0);
  assert.equal(result.notebook.words[0].id, word.id);
  assert.equal(result.notebook.words[0].dueAt, incomingWord.dueAt);
  assert.equal(result.notebook.reviews[0].wordId, word.id);
});

test('failed storage writes propagate and do not alter existing saved data', () => {
  const old = JSON.stringify(emptyNotebook());
  const storage = { getItem: () => old, setItem: () => { throw new Error('Quota exceeded'); } };
  assert.throws(() => saveNotebook(storage, { version: 1, words: [makeWord()], reviews: [] }), /Quota exceeded/);
  assert.equal(storage.getItem(STORAGE_KEY), old);
});

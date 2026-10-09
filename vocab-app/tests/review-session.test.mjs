import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, createWord, scheduleWord, reviewProgress, validateNotebook, mergeNotebooks } from '../dist/notebook.js';
import { createReviewSession, readyCard, retryDelay, completeCard, answerMatches } from '../dist/review-session.js';

const now = 1_800_000_000_000;
const word = (name = 'compelling') => createWord({ word: name, meaning: 'Interesting or convincing' }, now);
const notebook = words => ({ version: 2, words, reviews: [] });

test('meaning and word recall schedule independently, including Again resets', () => {
  const original = word();
  const understood = scheduleWord(original, 'easy', now, 'meaning');
  assert.deepEqual(understood.production, original.production);
  const used = scheduleWord(understood, 'good', now + 100, 'word');
  assert.equal(used.dueAt, now + 4 * DAY);
  assert.equal(used.production.dueAt, now + 100 + DAY);
  assert.equal(used.production.repetitions, 1);
  const missed = scheduleWord(used, 'again', now + 200, 'word');
  assert.equal(missed.production.dueAt, now + 60_200);
  assert.equal(missed.production.repetitions, 0);
  assert.equal(missed.production.lapses, 1);
  assert.equal(missed.repetitions, 1);
  assert.equal(used.production.repetitions, 1);
  assert.throws(() => reviewProgress(used, 'other'));
});

test('each mode includes only words due in that direction', () => {
  const understood = scheduleWord(word(), 'good', now);
  assert.equal(createReviewSession([understood], 'meaning', now).queue.length, 0);
  assert.equal(createReviewSession([understood], 'word', now).queue.length, 1);
  const used = scheduleWord(understood, 'good', now, 'word');
  assert.equal(createReviewSession([used], 'word', now).queue.length, 0);
});

test('a one-word session does not repeat Again until the full minute has passed', () => {
  const item = word();
  const session = createReviewSession([item], 'meaning', now);
  completeCard(session, item.id, 'again', now + 60_000);
  assert.equal(readyCard(session, now), null);
  assert.equal(retryDelay(session, now), 60_000);
  assert.equal(readyCard(session, now + 59_999), null);
  assert.equal(readyCard(session, now + 60_000).id, item.id);
  assert.equal(session.completed, 0);
  assert.equal(session.total, 1);
});

test('other ready words come before delayed retries and the active card stays stable', () => {
  const first = word('mitigate');
  const second = word();
  const session = createReviewSession([first, second], 'word', now);
  completeCard(session, first.id, 'again', now + 60_000);
  assert.equal(readyCard(session, now + 100).id, second.id);
  session.currentId = second.id;
  assert.equal(readyCard(session, now + 65_000).id, second.id);
  completeCard(session, second.id, 'good', now + DAY);
  assert.equal(readyCard(session, now + 65_000).id, first.id);
  completeCard(session, first.id, 'good', now + DAY);
  assert.equal(session.queue.length, 0);
  assert.equal(session.completed, 2);
  assert.equal(session.currentId, null);
});

test('a saved delayed retry remains delayed after reopening or switching sessions', () => {
  const missed = scheduleWord(word(), 'again', now, 'word');
  assert.equal(createReviewSession([missed], 'word', now + 59_999).queue.length, 0);
  assert.equal(createReviewSession([missed], 'word', now + 60_000).queue.length, 1);
  assert.equal(createReviewSession([missed], 'meaning', now).queue.length, 1);
});

test('a new attempt clears the previous typed answer and forgotten flag', () => {
  const item = word();
  const session = createReviewSession([item], 'word', now);
  Object.assign(session, { answer: 'convincing', forgot: true, revealed: true });
  completeCard(session, item.id, 'again', now + 60_000);
  assert.equal(session.answer, '');
  assert.equal(session.forgot, false);
  assert.equal(session.revealed, false);
});

test('typed answer comparison tolerates case and spacing but does not grade synonyms', () => {
  assert.equal(answerMatches(' COMPELLING ', 'compelling'), true);
  assert.equal(answerMatches('take   into account', 'take into account'), true);
  assert.equal(answerMatches('ｃｏｍｐｅｌｌｉｎｇ', 'compelling'), true);
  assert.equal(answerMatches('convincing', 'compelling'), false);
  assert.equal(answerMatches('', 'compelling'), false);
});

test('combining backups retains the newest progress in each direction independently of content', () => {
  const original = word();
  const current = scheduleWord(original, 'easy', now + 100, 'meaning');
  const incoming = scheduleWord(original, 'good', now + 200, 'word');
  const combined = mergeNotebooks(notebook([current]), notebook([incoming])).notebook;
  assert.equal(combined.words[0].dueAt, current.dueAt);
  assert.deepEqual(combined.words[0].production, incoming.production);
  const edited = { ...original, note: 'New content', updatedAt: now + 300 };
  const merged = mergeNotebooks(combined, notebook([edited])).notebook;
  assert.equal(merged.words[0].note, 'New content');
  assert.equal(merged.words[0].dueAt, current.dueAt);
  assert.deepEqual(merged.words[0].production, incoming.production);
  assert.deepEqual(original.production, word().production);
  assert.equal(current.production.lastReviewedAt, null);
});

test('v2 JSON round trips retain both directions and reject malformed productive progress', () => {
  const item = scheduleWord(scheduleWord(word(), 'easy', now), 'good', now, 'word');
  const value = { ...notebook([item]), reviews: [{ id: 'review', wordId: item.id, rating: 'good', at: now, direction: 'word' }] };
  assert.deepEqual(validateNotebook(JSON.parse(JSON.stringify(value))), value);
  for (const production of [null, {}, { ...item.production, dueAt: -1 }, { ...item.production, repetitions: 0.5 }, { ...item.production, lastReviewedAt: Number.MAX_SAFE_INTEGER }]) {
    assert.throws(() => validateNotebook(notebook([{ ...item, production }])));
  }
  assert.throws(() => validateNotebook({ ...value, reviews: [{ ...value.reviews[0], direction: 'other' }] }));
});

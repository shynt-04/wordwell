import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../database.mjs';
import { createTelegramGateway } from '../telegram.mjs';
import { createTelegramStore, validateTelegramConfig, tokenNamespace } from '../telegram-settings.mjs';
import { telegramCall } from '../telegram-api.mjs';
import { createAppServer } from '../server.mjs';
import { createWord, scheduleWord, emptyNotebook } from '../dist/notebook.js';

const token = '123456789:telegram_fake_token_for_isolated_tests';
const owner = 12345;
const initialTime = Date.parse('2026-10-13T13:00:00Z');
const preferences = revision => ({ revision, token, enabled: true, reminders: true, reminderTime: '19:00', timeZone: 'Asia/Bangkok', allowAI: false, keepRunningTray: false });
const privateMessage = (id, text, at, userId = owner) => ({ update_id: id, message: { message_id: id, date: Math.floor(at / 1000), text, chat: { id: userId, type: 'private' }, from: { id: userId, is_bot: false } } });

function transport({ webhook = '', failure = null } = {}) {
  const calls = [], messages = [];
  let messageId = 100;
  const fetchImpl = async (url, options) => {
    const method = new URL(url).pathname.split('/').at(-1), payload = JSON.parse(options.body);
    calls.push({ method, payload, options });
    if (failure) return new Response(JSON.stringify({ ok: false, error_code: failure, description: `${token}: deliberately secret upstream description` }), { status: failure });
    let result = true;
    if (method === 'getMe') result = { id: 123456789, is_bot: true, username: 'wordwell_test_bot' };
    if (method === 'getWebhookInfo') result = { url: webhook };
    if (method === 'getUpdates') result = [];
    if (method === 'sendMessage') { result = { message_id: ++messageId, chat: { id: payload.chat_id, type: 'private' }, text: payload.text }; messages.push({ ...result, buttons: payload.reply_markup?.inline_keyboard?.flat() || [] }); }
    return new Response(JSON.stringify({ ok: true, result }));
  };
  return { fetchImpl, calls, messages };
}

async function fixture(t, { words = [], allowAI = false, path = null, getAI, aiCompleter } = {}) {
  const database = createDatabase(':memory:');
  database.save('notebook', { revision: 0, value: { ...emptyNotebook(), words } });
  const api = transport();
  let now = initialTime;
  const gateway = await createTelegramGateway({ database, fetchImpl: api.fetchImpl, clock: () => now, autoPoll: false, path, getAI, aiCompleter });
  t.after(async () => { gateway.stop(); await gateway.idle(); database.close(); });
  await gateway.configure({ ...preferences(0), allowAI });
  const paired = await gateway.pair(gateway.state().revision);
  await gateway.handleUpdate(privateMessage(1, `/start ${paired.pairing.code}`, now));
  assert.equal(gateway.state().linked, true);
  return { database, gateway, ...api, advance: ms => { now += ms; }, message: (id, text, userId) => gateway.handleUpdate(privateMessage(id, text, now, userId)), async click(id, action, message = api.messages.at(-1), userId = owner) {
    const button = message.buttons.find(button => button.callback_data.endsWith(`:${action}`));
    assert.ok(button, `Missing ${action} button`);
    return gateway.handleUpdate({ update_id: id, callback_query: { id: `query-${id}`, data: button.callback_data, from: { id: userId, is_bot: false }, message: { message_id: message.message_id, chat: { id: owner, type: 'private' } } } });
  } };
}

test('Telegram options strictly validate token, time, timezone, revision, unknown fields and desktop capability', () => {
  assert.equal(validateTelegramConfig(preferences(0)).timeZone, 'Asia/Bangkok');
  for (const change of [{ revision: -1 }, { token: 'bad' }, { token: `${token}\nsecret` }, { reminderTime: '25:00' }, { timeZone: 'Not/AZone' }, { allowAI: 'yes' }, { keepRunningTray: true }, { chatId: owner }]) assert.throws(() => validateTelegramConfig({ ...preferences(0), ...change }));
  assert.equal(validateTelegramConfig({ ...preferences(0), keepRunningTray: true }, true).keepRunningTray, true);
});

test('Telegram API sends only HTTPS requests and redacts tokens, raw errors and upstream descriptions', async () => {
  for (const status of [401, 403, 409, 429, 500]) {
    await assert.rejects(telegramCall(token, 'getMe', {}, { fetchImpl: transport({ failure: status }).fetchImpl }), error => !error.message.includes(token) && !error.message.includes('upstream'));
  }
  await assert.rejects(telegramCall(token, 'getMe', {}, { fetchImpl: async () => { throw new Error(`Failed https://api.telegram.org/bot${token}/getMe`); } }), error => !error.message.includes(token) && !error.message.includes('https'));
  await assert.rejects(telegramCall(token, 'deleteWebhook', {}));
  await assert.rejects(telegramCall(token, 'getMe', {}, { fetchImpl: async () => new Response('not json') }));
  await assert.rejects(telegramCall(token, 'getMe', {}, { fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)) }));
});

test('bot setup preserves existing webhooks and disabled setup does not contact Telegram', async t => {
  const database = createDatabase(':memory:'); t.after(() => database.close());
  const api = transport({ webhook: 'https://other.example.test/webhook' });
  const gateway = await createTelegramGateway({ database, fetchImpl: api.fetchImpl, autoPoll: false }); t.after(() => gateway.stop());
  await gateway.configure({ ...preferences(0), enabled: false, token: '' });
  assert.equal(api.calls.length, 0);
  await assert.rejects(gateway.configure(preferences(gateway.state().revision)), /webhook/);
  assert.deepEqual(api.calls.map(call => call.method), ['getMe', 'getWebhookInfo']);
  assert.equal(gateway.state().enabled, false);
});

test('pairing requires a fresh secret in a private non-bot account, is single-use, and never appears in public settings', async () => {
  let now = initialTime;
  const store = await createTelegramStore({ clock: () => now });
  await store.save(preferences(0), 'wordwell_test_bot');
  let pair = await store.pair(store.publicState().revision);
  const message = privateMessage(1, '', now).message;
  assert.equal(await store.claim('a'.repeat(36), message), false);
  assert.equal(await store.claim(pair.code, { ...message, date: message.date - 30 }), false);
  assert.equal(await store.claim(pair.code, { ...message, chat: { id: -1, type: 'group' } }), false);
  assert.equal(await store.claim(pair.code, { ...message, from: { id: owner, is_bot: true } }), false);
  assert.equal(await store.claim(pair.code, { ...message, chat: { id: owner + 1, type: 'private' } }), false);
  now += 10 * 60_000;
  assert.equal(await store.claim(pair.code, message), false);
  pair = await store.pair(store.publicState().revision);
  assert.equal(await store.claim(pair.code, privateMessage(2, '', now).message), true);
  assert.equal(await store.claim(pair.code, privateMessage(3, '', now, owner + 1).message), false);
  const visible = JSON.stringify(store.publicState());
  assert.ok(!visible.includes(token) && !visible.includes(pair.code) && !visible.includes(String(owner)));
});

test('unlinked users and group messages cannot inspect, add, pause or review the notebook', async t => {
  const f = await fixture(t);
  const count = f.messages.length;
  for (const text of ['/stats', '/review', '/add leak | meaning', '/pause', '/suggest test']) await f.message(10, text, owner + 1);
  const group = privateMessage(11, '/stats', initialTime); group.message.chat = { id: -1, type: 'group' };
  await f.gateway.handleUpdate(group);
  assert.equal(f.messages.length, count);
  assert.equal(f.database.read('notebook').notebook.words.length, 0);
  assert.equal(f.gateway.state().paused, false);
});

test('adding a word needs preview confirmation; duplicate clicks and existing words preserve all progress and notes', async t => {
  const existing = scheduleWord(createWord({ word: 'old', meaning: 'Existing', note: 'Keep my note' }, initialTime), 'easy', initialTime, 'word');
  const f = await fixture(t, { words: [existing] });
  await f.message(2, '/add portable | Easy to carry. -> Có thể mang theo');
  assert.equal(f.database.read('notebook').notebook.words.length, 1);
  const preview = f.messages.at(-1);
  await f.click(3, 'save', preview, owner + 1);
  assert.equal(f.database.read('notebook').notebook.words.length, 1);
  await f.click(4, 'save', preview);
  await f.click(5, 'save', preview);
  await f.click(4, 'save', preview);
  const notebook = f.database.read('notebook').notebook;
  assert.equal(notebook.words.length, 2);
  assert.deepEqual(notebook.words[0], existing);
  await f.message(6, '/add PORTABLE | overwrite');
  assert.match(f.messages.at(-1).text, /already/);
  assert.equal(f.database.read('notebook').notebook.words[1].meaning, 'Easy to carry. -> Có thể mang theo');
});

test('cancelled and expired previews cannot save words and changing tokens removes the old account link', async t => {
  const f = await fixture(t);
  await f.message(2, '/add cancelled | Not saved'); const cancelled = f.messages.at(-1);
  await f.click(3, 'cancel', cancelled); await f.click(4, 'save', cancelled);
  await f.message(5, '/add expired | Not saved'); const expired = f.messages.at(-1);
  f.advance(10 * 60_000); await f.click(6, 'save', expired);
  assert.equal(f.database.read('notebook').notebook.words.length, 0);
  await f.gateway.configure({ ...preferences(f.gateway.state().revision), token: '987654321:a_different_fake_token_for_tests' });
  assert.equal(f.gateway.state().linked, false);
  await f.message(7, '/stats');
  assert.ok(!f.messages.at(-1).text.includes('words saved'));
});

test('both Telegram review modes retain independent schedules and recorded directions', async t => {
  const word = createWord({ word: 'portable', meaning: 'Easy to carry.' }, initialTime);
  const f = await fixture(t, { words: [word] });
  await f.message(2, '/review'); const prompt = f.messages.at(-1);
  await f.click(3, 'reveal', prompt); const revealed = f.messages.at(-1);
  await f.click(4, 'good', revealed); await f.click(5, 'good', revealed);
  let notebook = f.database.read('notebook').notebook;
  assert.equal(notebook.reviews.length, 1); assert.equal(notebook.reviews[0].direction, 'meaning');
  assert.deepEqual(notebook.words[0].production, word.production);
  const recognitionDue = notebook.words[0].dueAt;
  await f.message(6, '/review use');
  assert.ok(!f.messages.at(-1).text.includes('portable'));
  await f.message(7, ' PORTABLE '); const useAnswer = f.messages.at(-1);
  assert.match(useAnswer.text, /Exact match/);
  await f.click(8, 'easy', useAnswer);
  notebook = f.database.read('notebook').notebook;
  assert.equal(notebook.reviews.length, 2); assert.equal(notebook.reviews[1].direction, 'word');
  assert.equal(notebook.words[0].dueAt, recognitionDue);
  assert.equal(notebook.words[0].production.interval, 4);
});

test('Again waits one minute, ratings require reveal, and wrong message IDs cannot apply an action', async t => {
  const f = await fixture(t, { words: [createWord({ word: 'one', meaning: 'First' }, initialTime)] });
  await f.gateway.configure({ ...preferences(f.gateway.state().revision), reminders: false });
  await f.message(2, '/review'); const prompt = f.messages.at(-1);
  const forged = { update_id: 3, callback_query: { id: 'forged', data: prompt.buttons[0].callback_data.replace(':reveal', ':good'), from: { id: owner, is_bot: false }, message: { message_id: prompt.message_id, chat: { id: owner, type: 'private' } } } };
  await f.gateway.handleUpdate(forged); assert.equal(f.database.read('notebook').notebook.reviews.length, 0);
  const mismatch = structuredClone(forged); mismatch.callback_query.data = prompt.buttons[0].callback_data; mismatch.callback_query.message.message_id++;
  await f.gateway.handleUpdate(mismatch); assert.equal(f.messages.at(-1), prompt);
  await f.click(4, 'reveal', prompt); await f.click(5, 'again');
  assert.equal(f.database.read('notebook').notebook.words[0].dueAt, initialTime + 60000);
  const count = f.messages.length; f.advance(59999); await f.gateway.tick(); assert.equal(f.messages.length, count);
  f.advance(1); await f.gateway.tick(); assert.match(f.messages.at(-1).text, /Understand/);
});

test('desktop changes make Telegram ratings stale, and Telegram additions invalidate stale desktop saves', async t => {
  const word = createWord({ word: 'one', meaning: 'First' }, initialTime);
  const f = await fixture(t, { words: [word] });
  await f.message(2, '/review'); await f.click(3, 'reveal'); const answer = f.messages.at(-1);
  const current = f.database.read('notebook');
  f.database.save('notebook', { revision: current.revision, value: { ...current.notebook, words: [scheduleWord(word, 'easy', initialTime)] } });
  await f.click(4, 'good', answer);
  assert.match(f.messages.at(-1).text, /changed|elsewhere/);
  assert.equal(f.database.read('notebook').notebook.reviews.length, 0);
  assert.equal(f.database.read('notebook').notebook.words[0].interval, 4);
  const stale = f.database.read('notebook');
  await f.message(5, '/add fresh | New'); await f.click(6, 'save');
  assert.throws(() => f.database.save('notebook', { revision: stale.revision, value: stale.notebook }), /changed/);
  assert.equal(f.database.read('notebook').notebook.words.length, 2);
});

test('reminders obey timezone/time, pause, zero due counts and once-per-day persistence', async t => {
  const f = await fixture(t, { words: [createWord({ word: 'one', meaning: 'First' }, initialTime)] });
  await f.gateway.configure({ ...preferences(f.gateway.state().revision), reminderTime: '21:00' });
  let count = f.messages.length; await f.gateway.tick(); assert.equal(f.messages.length, count);
  f.advance(60 * 60_000); await f.message(2, '/pause'); count = f.messages.length;
  await f.gateway.tick(); assert.equal(f.messages.length, count);
  await f.message(3, '/resume'); count = f.messages.length;
  await f.gateway.tick(); assert.equal(f.messages.length, count + 1);
  await f.gateway.tick(); assert.equal(f.messages.length, count + 1);
  f.advance(24 * 60 * 60_000); await f.gateway.tick(); assert.equal(f.messages.length, count + 2);
  const empty = await fixture(t); count = empty.messages.length; await empty.gateway.tick(); assert.equal(empty.messages.length, count);
});

test('AI is opt-in, request replay cannot charge twice, and suggestions are previews only', async t => {
  let requests = 0;
  const f = await fixture(t, { getAI: async () => ({ apiKey: 'test-only-key' }), aiCompleter: async word => { requests++; return { meaning: 'Easy to carry.\n-> Có thể mang theo', pronunciation: '/x/', synonyms: 'movable', example: `A ${word} notebook.` }; } });
  await f.message(2, '/suggest portable'); assert.equal(requests, 0);
  await f.gateway.configure({ ...preferences(f.gateway.state().revision), allowAI: true });
  await f.message(3, '/suggest portable'); await f.message(3, '/suggest portable');
  assert.equal(requests, 1); assert.equal(f.database.read('notebook').notebook.words.length, 0);
  await f.click(4, 'save'); assert.equal(f.database.read('notebook').notebook.words.length, 1);
  await f.message(5, '/suggest PORTABLE'); assert.equal(requests, 1); assert.match(f.messages.at(-1).text, /No AI request/);
});

test('settings persist privately, preserve corrupt files, reject stale revisions and disconnect without erasing notebook', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wordwell-telegram-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'telegram-settings.json');
  const f = await fixture(t, { path, words: [createWord({ word: 'one', meaning: 'First' }, initialTime)] });
  const visible = JSON.stringify(f.gateway.state()); assert.ok(!visible.includes(token));
  const saved = JSON.parse(await readFile(path, 'utf8')); assert.equal(saved.token, token); assert.equal(saved.owner.userId, owner); assert.equal(saved.pairing, null);
  const restored = await createTelegramStore({ path, clock: () => initialTime }); assert.equal(restored.publicState().linked, true);
  await assert.rejects(f.gateway.configure(preferences(0)), /changed/);
  await f.gateway.disconnect(f.gateway.state().revision);
  assert.equal(f.gateway.state().hasToken, false); assert.equal(f.database.read('notebook').notebook.words.length, 1);
  await writeFile(path, '{broken');
  const broken = await createTelegramStore({ path }); assert.match(broken.publicState().error, /not been overwritten/);
  await assert.rejects(broken.save(preferences(0), 'wordwell_test_bot'));
  assert.equal(await readFile(path, 'utf8'), '{broken');
});

test('gateway mutations roll back receipts and data on validation errors and ignore replayed updates', t => {
  const database = createDatabase(':memory:'); t.after(() => database.close());
  const namespace = tokenNamespace(token);
  assert.throws(() => database.mutateNotebook(namespace, 1, notebook => ({ notebook: { ...notebook, version: 99 } })));
  assert.equal(database.hasGatewayReceipt(namespace, 1), false); assert.equal(database.notebookRevision(), 0);
  database.mutateNotebook(namespace, 1, notebook => ({ notebook: { ...notebook, words: [createWord({ word: 'one', meaning: 'First' }, initialTime)] } }));
  assert.equal(database.notebookRevision(), 1);
  assert.equal(database.mutateNotebook(namespace, 1, () => { throw new Error('must not run'); }).duplicate, true);
});

test('Telegram settings endpoints enforce local origin, JSON, methods and private-file guards', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wordwell-telegram-api-'));
  const api = transport();
  const server = createAppServer({ database: createDatabase(':memory:'), settingsPath: join(directory, 'ai.json'), telegramFetch: api.fetchImpl, telegramAutoPoll: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (suffix, options) => fetch(`${base}/api/settings/telegram${suffix}`, options);
  assert.equal((await req('', { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await req('', { method: 'PUT', body: '{}' })).status, 415);
  assert.equal((await req('', { method: 'DELETE' })).status, 405);
  let response = await req('', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(preferences(0)) });
  assert.equal(response.status, 200); let result = await response.json(); assert.equal(result.hasToken, true); assert.ok(!JSON.stringify(result).includes(token));
  assert.equal((await req('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: result.revision, extra: true }) })).status, 400);
  response = await req('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: result.revision }) });
  result = await response.json(); assert.match(result.pairing.code, /^[a-f0-9]{36}$/);
  assert.ok(!JSON.stringify(await (await req('')).json()).includes(result.pairing.code));
  for (const url of ['/data/telegram-settings.json', '/telegram.mjs', '/telegram-settings.mjs', '/telegram-api.mjs']) assert.equal((await fetch(base + url)).status, 404);
  assert.equal((await fetch(`${base}/api/storage/notebook-revision`)).status, 200);
});

test('polling uses stored offsets and cancels pending requests on shutdown', async t => {
  const database = createDatabase(':memory:'); const api = transport(); let pollSignal, resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const fetchImpl = async (url, options) => {
    if (!url.endsWith('/getUpdates')) return api.fetchImpl(url, options);
    const input = JSON.parse(options.body); assert.equal(input.timeout, 25); assert.equal(input.offset, 0);
    assert.deepEqual(input.allowed_updates, ['message', 'callback_query']); pollSignal = options.signal; resolveStarted();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error(`secret ${token}`)), { once: true }));
  };
  const gateway = await createTelegramGateway({ database, fetchImpl }); t.after(async () => { gateway.stop(); await gateway.idle(); database.close(); });
  await gateway.configure(preferences(0)); await started;
  gateway.stop(); assert.equal(pollSignal.aborted, true); await gateway.idle(); assert.equal(gateway.state().running, false);
});

test('reminder attempts and pair ownership survive restart without duplicate notifications', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wordwell-telegram-restart-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'telegram.json');
  const f = await fixture(t, { path, words: [createWord({ word: 'one', meaning: 'First' }, initialTime)] });
  await f.gateway.tick(); const before = f.messages.length;
  const restarted = await createTelegramGateway({ database: f.database, path, fetchImpl: f.fetchImpl, autoPoll: false, clock: () => initialTime });
  t.after(() => restarted.stop()); restarted.start();
  assert.equal(restarted.state().linked, true);
  await restarted.tick(); assert.equal(f.messages.length, before);
});

test('disconnecting during an AI request aborts its result and cannot produce a late preview', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { allowAI: true, getAI: async () => ({}), aiCompleter: async () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const active = f.message(2, '/suggest portable');
  await waiting; await f.gateway.disconnect(f.gateway.state().revision);
  const before = f.messages.length;
  release({ meaning: 'Portable', pronunciation: '', synonyms: '', example: '' });
  await assert.rejects(active, /stopped/);
  assert.equal(f.messages.length, before); assert.equal(f.database.read('notebook').notebook.words.length, 0);
});

test('network polling checkpoints ignored updates without returning secrets or replaying them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wordwell-telegram-offset-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'telegram.json');
  const database = createDatabase(':memory:'), api = transport();
  let seen = 0, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const gateway = await createTelegramGateway({ database, path, fetchImpl: async (url, options) => {
    if (!url.endsWith('/getUpdates')) return api.fetchImpl(url, options);
    seen++;
    const input = JSON.parse(options.body);
    if (seen === 1) return new Response(JSON.stringify({ ok: true, result: [privateMessage(15, '/stats', initialTime, owner + 1)] }));
    assert.equal(input.offset, 16); resolveDone();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  } });
  t.after(async () => { gateway.stop(); await gateway.idle(); database.close(); });
  await gateway.configure(preferences(0)); await done;
  assert.equal(JSON.parse(await readFile(path, 'utf8')).offset, 16); assert.equal(api.messages.length, 0);
});

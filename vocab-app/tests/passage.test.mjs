import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePassageInput, validateExtractionInput, validateExtractionResult, validatePassageResult, passageCardFields, newPassageCards } from '../dist/passage-data.js';
import { analysePassage, extractPassage, validateExtractionRequest } from '../passage.mjs';
import { generateJSON } from '../ai-client.mjs';
import { readPassageResponse } from '../dist/passage.js';
import { createWord, scheduleWord } from '../dist/notebook.js';
import { createDatabase } from '../database.mjs';
import { createAppServer } from '../server.mjs';

const input = { type: 'reading', title: 'Practice passage 2', passage: 'The release was delayed because additional testing was needed.', questions: '4. Why did the company postpone the launch?', answerNotes: '', unfamiliar: 'delayed' };
const suggestion = { word: 'delay', meaning: 'To make something happen later.\n-> Trì hoãn', pronunciation: '/dɪˈleɪ/', synonyms: 'postpone', priority: 'learn-now', reason: 'Useful when talking about plans.', sourceQuote: input.passage, sourcePhrase: 'delayed', questionQuote: input.questions, questionPhrase: 'postpone', relationship: 'synonym', connection: 'Both refer to making an event happen later, in this context.' };
const result = { summary: 'A useful connection from this passage.', limitations: [], suggestions: [suggestion] };
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const otherPNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0k';
const completion = data => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] }), { status: 200 });

test('passage requests accept optional questions and personal notes, but reject unexpected fields and oversized text', () => {
  assert.deepEqual(validatePassageInput(input), input);
  assert.deepEqual(validatePassageInput({ type: 'listening', passage: 'A transcript.' }), { type: 'listening', title: '', passage: 'A transcript.', questions: '', answerNotes: '', unfamiliar: '' });
  for (const value of [{ ...input, image: png }, { ...input, passage: ' ' }, { ...input, type: 'audio' }, { ...input, questions: 'x'.repeat(10001) }, { ...input, passage: 'x\u0000' }, { ...input, title: 12 }]) assert.throws(() => validatePassageInput(value));
});

test('extraction accepts ordered bounded image data only, never URLs, paths or SVG', () => {
  assert.deepEqual(validateExtractionRequest({ section: 'passage', images: [png, otherPNG] }).images, [png, otherPNG]);
  for (const images of [[], Array(5).fill(png), ['http://localhost/private'], ['E:/private.txt'], ['data:image/svg+xml;base64,PHN2Zz4='], ['data:image/png;base64,aGVsbG8='], ['data:image/png;base64,A']]) {
    assert.throws(() => validateExtractionRequest({ section: 'questions', images }));
  }
  assert.throws(() => validateExtractionInput({ section: 'answers', images: [png] }));
  assert.throws(() => validateExtractionInput({ section: 'passage', images: [png], path: 'secret' }));
  assert.throws(() => validateExtractionInput({ section: 'passage', images: ['data:image/png;base64,' + 'A'.repeat(2_800_000)] }));
});

test('extracted text is bounded, editable text with warnings, not an invented success for unreadable images', () => {
  assert.deepEqual(validateExtractionResult({ text: input.questions, warnings: ['Check question 4.'] }, 'questions'), { text: input.questions, warnings: ['Check question 4.'] });
  assert.throws(() => validateExtractionResult({ text: '', warnings: [] }, 'passage'));
  assert.throws(() => validateExtractionResult({ text: 'x'.repeat(10001), warnings: [] }, 'questions'));
  assert.throws(() => validateExtractionResult({ text: 'A passage', warnings: ['x'.repeat(401)] }, 'passage'));
});

test('suggestions preserve bilingual meanings and verified question connections', () => {
  assert.deepEqual(validatePassageResult(result, input), result);
  const fields = passageCardFields(suggestion, input);
  assert.equal(fields.example, input.passage);
  assert.match(fields.note, /Practice passage 2/);
  assert.match(fields.note, /Question: 4\./);
  assert.match(fields.note, /postpone ↔ delayed/);
  assert.equal(fields.synonyms, 'postpone');
  assert.equal(fields.meaning, suggestion.meaning);
  assert.ok(fields.note.length <= 3000);
});

test('fabricated passage quotes, source phrases and duplicate words are omitted', () => {
  for (const patch of [{ sourceQuote: 'Invented passage.' }, { sourcePhrase: 'made-up word' }]) {
    const checked = validatePassageResult({ ...result, suggestions: [{ ...suggestion, ...patch }] }, input);
    assert.equal(checked.suggestions.length, 0);
    assert.match(checked.limitations.at(-1), /unsupported/);
  }
  const checked = validatePassageResult({ ...result, suggestions: [suggestion, { ...suggestion, word: 'DELAY' }] }, input);
  assert.equal(checked.suggestions.length, 1);
});

test('unsupported question evidence is removed without losing a grounded source word', () => {
  for (const patch of [{ questionQuote: 'Invented question' }, { questionPhrase: 'made-up phrase' }, { connection: '' }]) {
    const checked = validatePassageResult({ ...result, suggestions: [{ ...suggestion, ...patch }] }, input);
    assert.equal(checked.suggestions[0].relationship, 'none');
    assert.equal(checked.suggestions[0].questionQuote, '');
    assert.equal(checked.suggestions[0].connection, '');
    assert.match(checked.limitations.at(-1), /question connections/);
  }
  const checked = validatePassageResult(result, { ...input, questions: '' });
  assert.equal(checked.suggestions[0].questionPhrase, '');
  assert.ok(!passageCardFields(checked.suggestions[0], input).note.includes('Question:'));
});

test('contextual synonyms, paraphrases and related expressions stay explicitly distinguished', () => {
  for (const relationship of ['synonym', 'paraphrase', 'related']) {
    const checked = validatePassageResult({ ...result, suggestions: [{ ...suggestion, relationship }] }, input);
    assert.equal(checked.suggestions[0].relationship, relationship);
  }
  assert.match(passageCardFields({ ...suggestion, relationship: 'related' }, input).note, /not equivalent/);
  assert.throws(() => validatePassageResult({ ...result, suggestions: [{ ...suggestion, relationship: 'always-equal' }] }, input));
});

test('malformed suggestions and unsupported priorities cannot create card previews', () => {
  for (const patch of [{ priority: 'band9' }, { meaning: 'English only' }, { word: '' }, { reason: 'x'.repeat(401) }, { synonyms: ['postpone'] }]) assert.throws(() => validatePassageResult({ ...result, suggestions: [{ ...suggestion, ...patch }] }, input));
  assert.throws(() => validatePassageResult({ ...result, suggestions: Array(9).fill(suggestion) }, input));
  assert.equal(validatePassageResult({ ...result, suggestions: [] }, input).suggestions.length, 0);
});

test('selected cards skip existing words and duplicate selections without modifying prior notes or progress', () => {
  const original = scheduleWord(createWord({ word: 'delay', meaning: 'Existing definition', note: 'Private existing note' }, 1_800_000_000_000), 'easy', 1_800_000_000_000, 'word');
  const before = structuredClone(original);
  const fresh = { ...passageCardFields(suggestion, input), word: 'release' };
  const batch = newPassageCards([passageCardFields(suggestion, input), fresh, { ...fresh, word: 'RELEASE' }], [original]);
  assert.equal(batch.fields.length, 1);
  assert.equal(batch.skipped, 2);
  assert.deepEqual(original, before);
  assert.throws(() => newPassageCards([fresh, { ...fresh, meaning: '' }], []));
  assert.throws(() => newPassageCards([], []));
});

test('AI passage requests use the saved configuration, contain only supplied material and treat it as untrusted data', async () => {
  let body;
  const checked = await analysePassage(input, { apiKey: 'fixture-key', model: 'fixture-model', fetchImpl: async (url, options) => { assert.equal(options.headers.Authorization, 'Bearer fixture-key'); body = JSON.parse(options.body); return completion(result); } });
  assert.deepEqual(checked, result);
  assert.equal(body.model, 'fixture-model');
  assert.deepEqual(JSON.parse(body.messages[1].content), input);
  assert.match(body.messages[0].content, /untrusted DATA/);
  assert.match(body.messages[0].content, /never claim to have heard audio/);
  assert.equal(typeof body.messages[1].content, 'string');
});

test('extraction sends all screenshots in their original order with no question answering prompt', async () => {
  let body;
  const checked = await extractPassage({ section: 'questions', images: [png, otherPNG] }, { apiKey: 'fixture-key', fetchImpl: async (url, options) => { body = JSON.parse(options.body); return completion({ text: input.questions, warnings: [] }); } });
  assert.equal(checked.text, input.questions);
  assert.deepEqual(body.messages[1].content.slice(1).map(part => part.image_url.url), [png, otherPNG]);
  assert.match(body.messages[0].content, /Do not answer questions/);
  assert.match(body.messages[0].content, /untrusted data/);
});

test('multi-image requests keep native provider payloads ordered and preserve single-image Writing compatibility', async () => {
  for (const provider of ['gemini', 'claude', 'compatible']) {
    let body;
    const options = { provider, apiKey: 'fixture-key', model: 'fixture-model', baseUrl: 'https://provider.invalid/v1', system: 'Return JSON.', user: 'Read these.', maxTokens: 2000,
      fetchImpl: async (url, request) => {
        body = JSON.parse(request.body);
        return provider === 'gemini' ? new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"ok":true}' }] } }] }))
          : provider === 'claude' ? new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }] })) : completion({ ok: true });
      } };
    await generateJSON({ ...options, images: [png, otherPNG] });
    const parts = provider === 'gemini' ? body.contents[0].parts : body.messages[0].role === 'system' ? body.messages[1].content : body.messages[0].content;
    assert.equal(parts.length, 3);
    const extracted = parts.slice(1).map(part => provider === 'gemini' ? part.inlineData.data : provider === 'claude' ? part.source.data : part.image_url.url.split(',')[1]);
    assert.deepEqual(extracted, [png.split(',')[1], otherPNG.split(',')[1]]);
    await generateJSON({ ...options, image: png });
    const single = provider === 'gemini' ? body.contents[0].parts : provider === 'claude' ? body.messages[0].content : body.messages[1].content;
    assert.equal(single.length, 2);
  }
});

test('vision-disabled, incomplete and failed AI responses preserve controlled errors without provider secrets', async () => {
  await assert.rejects(extractPassage({ section: 'passage', images: [png] }, { apiKey: 'fixture-key', vision: false, fetchImpl: () => { throw new Error('Must not call provider'); } }), /Image input is disabled/);
  await assert.rejects(analysePassage(input, { apiKey: 'fixture-key', fetchImpl: () => completion({ ...result, suggestions: [{ ...suggestion, meaning: 'English only' }] }) }), error => error.status === 502);
  await assert.rejects(analysePassage(input, { apiKey: 'fixture-key', fetchImpl: () => new Response('secret provider text', { status: 500 }) }), error => !error.message.includes('secret provider text') && !error.message.includes('fixture-key'));
  await assert.rejects(readPassageResponse(new Response('Not found', { status: 404 })), /Restart/);
  await assert.rejects(readPassageResponse(new Response('{"error":"Not configured"}', { status: 503 })), /Not configured/);
});

test('stopping passage AI requests aborts the provider request', async () => {
  const controller = new AbortController();
  const pending = analysePassage(input, { apiKey: 'fixture-key', signal: controller.signal, fetchImpl: (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true })) });
  controller.abort();
  await assert.rejects(pending, /stopped/);
});

async function startServer(t, options = {}, vision = true) {
  const directory = await mkdtemp(join(tmpdir(), 'wordwell-passage-test-'));
  const settingsPath = join(directory, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({ version: 1, revision: 1, activeProvider: 'compatible', setupDismissed: true, profiles: { compatible: { baseUrl: 'https://fixture.invalid/v1', model: 'fixture-model', apiKey: 'fixture-key', jsonMode: true, vision, allowNoKey: false } } }));
  const server = createAppServer({ settingsPath, database: createDatabase(':memory:'), ...options });
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(directory, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, post: (path, value, headers = {}) => fetch(`${url}/api/passage/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, ...headers }, body: JSON.stringify(value) }) };
}

test('passage API uses saved AI settings and never writes cards or caches study material automatically', async t => {
  let calls = 0;
  const { url, post } = await startServer(t, { passageAnalyser: async (value, options) => { calls++; assert.deepEqual(value, input); assert.equal(options.model, 'fixture-model'); return result; }, passageExtractor: async value => ({ text: value.section === 'questions' ? input.questions : input.passage, warnings: [] }) });
  for (let attempt = 0; attempt < 2; attempt++) assert.deepEqual(await (await post('analyse', input)).json(), result);
  assert.equal(calls, 2);
  assert.equal((await post('extract', { section: 'questions', images: [png] })).status, 200);
  assert.equal((await (await fetch(`${url}/api/storage/notebook`)).json()).notebook.words.length, 0);
});

test('passage API rejects cross-origin, wrong-method, malformed, unsupported and oversized inputs before AI calls', async t => {
  let calls = 0;
  const { url, post } = await startServer(t, { passageAnalyser: async () => { calls++; return result; }, passageExtractor: async () => { calls++; return { text: input.passage, warnings: [] }; } });
  assert.equal((await post('analyse', input, { Origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await post('analyse', input, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(`${url}/api/passage/analyse`)).status, 405);
  assert.equal((await post('analyse', { ...input, passage: '' })).status, 400);
  assert.equal((await post('analyse', { ...input, privateNotebook: 'secret' })).status, 400);
  assert.equal((await post('extract', { section: 'passage', images: ['data:image/png;base64,aGVsbG8='] })).status, 400);
  assert.equal((await post('analyse', { ...input, passage: 'x'.repeat(250_000) })).status, 413);
  assert.equal(calls, 0);
});

test('image extraction is blocked at the API when image input is disabled but text analysis works', async t => {
  let extracted = false;
  const { post } = await startServer(t, { passageAnalyser: async () => result, passageExtractor: async () => { extracted = true; return { text: input.passage, warnings: [] }; } }, false);
  assert.equal((await post('extract', { section: 'passage', images: [png] })).status, 400);
  assert.equal((await post('analyse', input)).status, 200);
  assert.equal(extracted, false);
});

test('passage requests share the AI concurrency limit and disconnects stop the pending work', async t => {
  let started = 0;
  let resolveStarted;
  const ready = new Promise(resolve => { resolveStarted = resolve; });
  const { url } = await startServer(t, { passageAnalyser: async (value, { signal }) => {
    started++;
    if (started === 2) resolveStarted();
    await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    return result;
  } });
  const controllers = [new AbortController(), new AbortController()];
  const send = signal => fetch(`${url}/api/passage/analyse`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(input), signal });
  const pending = controllers.map(controller => send(controller.signal).catch(error => error.name));
  await ready;
  const third = await send();
  assert.equal(third.status, 429);
  assert.equal(started, 2);
  controllers.forEach(controller => controller.abort());
  assert.deepEqual(await Promise.all(pending), ['AbortError', 'AbortError']);
});

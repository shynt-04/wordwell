import test from 'node:test';
import assert from 'node:assert/strict';
import { fillEmptyFields, wireAutofill, readAutofillResponse } from '../dist/autofill.js';

const entry = { meaning: 'Convincing.', pronunciation: '/kəmˈpelɪŋ/', synonyms: 'convincing, persuasive', example: 'A compelling argument can change public opinion.' };

test('the original plain-text Not found response gives a restart instruction instead of a JSON error', async () => {
  const ui = setup(async () => new Response('Not found', { status: 404 }));
  ui.fields.example.value = 'My own example';
  await ui.complete();
  assert.match(ui.status.textContent, /Restart Wordwell/);
  assert.ok(!ui.status.textContent.includes('Unexpected token'));
  assert.equal(ui.fields.example.value, 'My own example');
  assert.equal(ui.fields.meaning.value, '');
  assert.equal(ui.save.disabled, false);
  assert.equal(ui.button.textContent, 'Fill with AI');
});

test('non-JSON proxy failures and successful HTML pages produce controlled errors', async () => {
  await assert.rejects(readAutofillResponse(new Response('<html>Private proxy detail</html>', { status: 502 })), error => error.message.includes('HTTP 502') && !error.message.includes('Private proxy detail'));
  await assert.rejects(readAutofillResponse(new Response('<html>Other app</html>')), /unexpected response/);
  await assert.rejects(readAutofillResponse(new Response('Method not allowed', { status: 405 })), /Restart Wordwell/);
});
class Control extends EventTarget {
  value = '';
  textContent = '';
  hidden = false;
  disabled = false;
  maxLength = 3000;
  classList = { toggle() {} };
  focus() {}
  setAttribute() {}
}
function setup(fetchImpl) {
  const wordInput = new Control(); wordInput.value = 'compelling';
  const fields = Object.fromEntries(['meaning', 'pronunciation', 'synonyms', 'example'].map(name => [name, new Control()]));
  const form = new Control(); const save = new Control(); form.querySelector = () => save;
  const status = new Control(); const button = new Control();
  const autoToggle = new Control(); autoToggle.checked = true;
  const autofill = wireAutofill({ form, wordInput, fields, status, button, autoToggle, fetchImpl });
  return { ...autofill, form, wordInput, fields, status, button, save, autoToggle };
}

test('suggestions fill only blank unchanged fields and validate all fields before changing any', () => {
  const fields = Object.fromEntries(['meaning', 'pronunciation', 'synonyms', 'example'].map(name => [name, new Control()]));
  const snapshots = { meaning: '', pronunciation: '', synonyms: '', example: '' };
  fields.meaning.value = 'My own definition';
  assert.equal(fillEmptyFields(fields, snapshots, entry), 3);
  assert.equal(fields.meaning.value, 'My own definition');
  assert.equal(fields.pronunciation.value, entry.pronunciation);
  fields.pronunciation.value = ''; fields.example.value = '';
  assert.throws(() => fillEmptyFields(fields, snapshots, { ...entry, example: '' }));
  assert.equal(fields.pronunciation.value, '');
});

test('autofill preserves edits made while waiting and keeps saving disabled until finished', async () => {
  let resolveRequest;
  const ui = setup(() => new Promise(resolve => { resolveRequest = resolve; }));
  const pending = ui.complete();
  assert.equal(ui.save.disabled, true);
  ui.fields.meaning.value = 'My manual meaning';
  ui.fields.synonyms.value = 'My own synonym';
  resolveRequest(new Response(JSON.stringify(entry)));
  await pending;
  assert.equal(ui.fields.meaning.value, 'My manual meaning');
  assert.equal(ui.fields.synonyms.value, 'My own synonym');
  assert.equal(ui.fields.example.value, entry.example);
  assert.equal(ui.save.disabled, false);
});

test('changing the word cancels a lookup and ignores a stale response', async () => {
  let resolveRequest;
  const ui = setup(() => new Promise(resolve => { resolveRequest = resolve; }));
  const pending = ui.complete();
  ui.wordInput.value = 'mitigate';
  ui.wordInput.dispatchEvent(new Event('input'));
  resolveRequest(new Response(JSON.stringify(entry)));
  await pending;
  assert.equal(ui.fields.meaning.value, '');
  assert.equal(ui.save.disabled, false);
});

test('API errors leave fields editable and existing notes outside the request', async () => {
  let sent;
  const ui = setup(async (url, options) => { sent = JSON.parse(options.body); return new Response(JSON.stringify({ error: 'Insufficient balance.' }), { status: 502 }); });
  ui.fields.example.value = 'My own example';
  await ui.complete();
  assert.deepEqual(sent, { word: 'compelling' });
  assert.equal(ui.fields.example.value, 'My own example');
  assert.equal(ui.fields.meaning.value, '');
  assert.equal(ui.save.disabled, false);
  assert.equal(ui.status.textContent, 'Insufficient balance.');
});

test('changing a completed word removes its untouched suggestions while keeping manual edits', async () => {
  const ui = setup(async () => new Response(JSON.stringify(entry)));
  await ui.complete();
  ui.fields.meaning.value = 'My edited definition';
  ui.wordInput.value = 'mitigate';
  ui.wordInput.dispatchEvent(new Event('input'));
  assert.equal(ui.fields.meaning.value, 'My edited definition');
  assert.equal(ui.fields.pronunciation.value, '');
  assert.equal(ui.fields.synonyms.value, '');
  assert.equal(ui.fields.example.value, '');
});

test('existing words can fill only missing synonyms while retaining their other fields', async () => {
  const ui = setup(async () => new Response(JSON.stringify(entry)));
  ui.fields.meaning.value = 'My saved meaning';
  ui.fields.pronunciation.value = 'My saved pronunciation';
  ui.fields.example.value = 'My saved example';
  await ui.complete();
  assert.equal(ui.fields.synonyms.value, entry.synonyms);
  assert.equal(ui.fields.meaning.value, 'My saved meaning');
  assert.equal(ui.fields.pronunciation.value, 'My saved pronunciation');
  assert.equal(ui.fields.example.value, 'My saved example');
});

test('Tab starts automatic filling and switching it off aborts the request', () => {
  let called = 0;
  let signal;
  const ui = setup((url, options) => {
    called++; signal = options.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { name: 'AbortError' })), { once: true }));
  });
  const tab = new Event('keydown');
  Object.defineProperty(tab, 'key', { value: 'Tab' });
  ui.wordInput.dispatchEvent(tab);
  assert.equal(called, 1);
  ui.autoToggle.checked = false;
  ui.autoToggle.dispatchEvent(new Event('change'));
  assert.equal(signal.aborted, true);
  assert.equal(ui.save.disabled, false);
  ui.wordInput.dispatchEvent(tab);
  assert.equal(called, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { initSettings } from '../dist/settings.js';

class Control {
  value = '';
  type = 'password';
  hidden = false;
  disabled = false;
  checked = false;
  textContent = '';
  classList = { toggle() {} };
  listeners = new Map();
  attributes = new Map();
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  replaceChildren() {}
  focus() {}
  async click() { await this.listeners.get('click')?.(); }
}

async function settingsUI(t, allowKeyReveal) {
  const elements = new Map();
  const control = id => {
    if (!elements.has(id)) elements.set(id, new Control());
    return elements.get(id);
  };
  const document = { getElementById: control, createElement: () => new Control(), addEventListener() {} };
  const window = { addEventListener() {} };
  const state = {
    revision: 0, activeProvider: 'deepseek', configured: true, setupDismissed: true, allowKeyReveal,
    providers: [{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'test-model', protocol: 'compatible' }],
    profiles: { deepseek: { hasKey: true, baseUrl: 'https://api.deepseek.com', model: 'test-model' } },
  };
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.endsWith('/key') ? { apiKey: 'test-key' } : state));
  };
  for (const [name, value] of Object.entries({ document, window, fetch, MutationObserver: class { observe() {} } })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
  await initSettings(() => {});
  return { control, calls };
}

test('disabled key reveal hides the button and blocks revealing saved and replacement keys', async t => {
  const { control, calls } = await settingsUI(t, false);
  const key = control('settings-key');
  const toggle = control('settings-key-toggle');
  assert.equal(toggle.hidden, true);
  assert.equal(toggle.disabled, true);
  assert.equal(key.type, 'password');
  assert.equal(key.readOnly, true);
  assert.equal(key.value, '••••••••••••••••');
  assert.ok(!control('settings-key-note').textContent.includes('Show / Hide'));
  await toggle.click();
  assert.equal(calls.length, 1);
  await control('settings-key-change').click();
  key.value = 'replacement-key';
  await toggle.click();
  assert.equal(key.type, 'password');
  assert.equal(key.readOnly, false);
  assert.equal(calls.length, 1);
});

test('enabled key reveal shows the saved key on request and hides it again', async t => {
  const { control, calls } = await settingsUI(t, true);
  const key = control('settings-key');
  const toggle = control('settings-key-toggle');
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.disabled, false);
  assert.ok(control('settings-key-note').textContent.includes('Show / Hide'));
  await toggle.click();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, '/api/settings/ai/key');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(key.value, 'test-key');
  assert.equal(key.type, 'text');
  assert.equal(toggle.textContent, 'Hide');
  await toggle.click();
  assert.equal(key.type, 'password');
  assert.equal(key.value, '••••••••••••••••');
  assert.equal(calls.length, 2);
});

test('missing reveal capability keeps the button disabled with older server responses', async t => {
  const { control, calls } = await settingsUI(t, undefined);
  assert.equal(control('settings-key-toggle').hidden, true);
  assert.equal(control('settings-key-toggle').disabled, true);
  await control('settings-key-toggle').click();
  assert.equal(calls.length, 1);
});

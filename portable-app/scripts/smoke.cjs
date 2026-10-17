const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createServer } = require('node:net');

const release = path.resolve(__dirname, '../release');
const executable = path.join(release, 'win-unpacked/Wordwell.exe');
if (!existsSync(executable)) { console.error('Build the portable app first: npm run app:build'); process.exit(1); }
const home = mkdtempSync(path.join(tmpdir(), 'wordwell-desktop-check-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let next = 0;
  const pending = new Map(), exceptions = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Desktop connection closed')); }
    pending.clear();
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  await call('Runtime.enable');
  return { call, evaluate, exceptions, close: () => socket.close() };
}

async function launch(exe, { overrideHome = true } = {}) {
  const port = await unusedPort();
  const mainPort = await unusedPort();
  const environment = { ...process.env };
  delete environment.PORTABLE_EXECUTABLE_DIR;
  if (overrideHome) environment.PORTABLE_EXECUTABLE_DIR = home;
  // Never inherit Electron's Node-only mode or the user's configured AI keys.
  for (const name of ['ELECTRON_RUN_AS_NODE', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'ENABLE_API_KEY_REVEAL']) delete environment[name];
  const child = spawn(exe, ['--wordwell-smoke-test', `--inspect=127.0.0.1:${mainPort}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', finished = false;
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  child.on('exit', () => { finished = true; });
  child.on('error', error => { output += error.message; finished = true; });
  let client, native;
  try {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !finished) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
        const targets = await response.json();
        const page = targets.find(target => target.type === 'page' && target.url.startsWith('http://127.0.0.1:'));
        if (page) { client = await connect(page.webSocketDebuggerUrl); break; }
      } catch { /* Window/server still starting. */ }
      await pause(150);
    }
    if (!client) throw new Error(`Desktop did not start. ${output.slice(-4000)}`);
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      // Chromium publishes the target before its first navigation commits.
      // Retry while its initial execution context is being replaced.
      try { ready = await client.evaluate(`document.querySelector('#settings-provider')?.options.length > 1 && document.querySelector('#add-form button[type="submit"]')?.disabled === false`); }
      catch (error) { if (!/context|Cannot find/iu.test(error.message)) throw error; }
      if (!ready) await pause(100);
    }
    if (!ready) throw new Error(`Wordwell UI did not finish loading. ${output.slice(-4000)}`);
    const mainTargets = await (await fetch(`http://127.0.0.1:${mainPort}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    native = await connect(mainTargets[0].webSocketDebuggerUrl);
    return { ...client, evaluateMain: native.evaluate, output: () => output, async stop() {
      const origin = await client.evaluate('location.origin');
      // A browser close intentionally hides a tray-enabled app. Exercise the
      // native Quit action instead, and detach its debugger before shutdown.
      await native.evaluate(`(() => { const e = process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app.asar/package.json')('electron'); setTimeout(() => e.app.quit(), 100); return true; })()`);
      native.close();
      for (let i = 0; i < 100 && !finished; i++) await pause(100);
      if (!finished) { child.kill(); throw new Error('Desktop did not stop after closing its window'); }
      client.close(); native.close();
      await assert.rejects(fetch(`${origin}/`, { signal: AbortSignal.timeout(1500) }), 'local server must stop when the app closes');
    } };
  } catch (error) { client?.close(); native?.close(); child.kill(); throw error; }
}

let running;
(async () => {
  // Inspect only the fresh runtime; never the website's personal data folder.
  const resources = path.join(release, 'win-unpacked/resources');
  assert.equal(existsSync(path.join(resources, 'data')), false);
  assert.equal(existsSync(path.join(resources, '.env')), false);
  assert.equal(existsSync(path.join(resources, 'vocab-app/tests')), false);
  const packagedFiles = readdirSync(path.join(resources, 'vocab-app'));
  assert.ok(packagedFiles.includes('server.mjs') && packagedFiles.includes('dist'));
  running = await launch(executable);
  assert.equal(await running.evaluateMain(`(async () => {
    const req = process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app.asar/package.json');
    const source = process.resourcesPath + '/vocab-app';
    const { createDatabase } = req(source + '/database.mjs');
    const { createTelegramGateway } = req(source + '/telegram.mjs');
    const db = createDatabase(':memory:');
    const now = Date.now(), messages = []; let messageId = 50;
    const bot = await createTelegramGateway({ database: db, autoPoll: false, clock: () => now, fetchImpl: async (url, options) => {
      const method = new URL(url).pathname.split('/').at(-1), payload = JSON.parse(options.body);
      let result = true;
      if (method === 'getMe') result = { is_bot: true, username: 'wordwell_smoke_bot' };
      if (method === 'getWebhookInfo') result = { url: '' };
      if (method === 'sendMessage') { result = { message_id: ++messageId }; messages.push({ ...payload, message_id: messageId }); }
      return new Response(JSON.stringify({ ok: true, result }));
    } });
    try {
      await bot.configure({ revision: 0, token: '123456789:fake_telegram_token_for_desktop_tests', enabled: true, reminders: false, reminderTime: '19:00', timeZone: 'Asia/Bangkok', allowAI: false, keepRunningTray: false });
      const pair = await bot.pair(bot.state().revision);
      const message = (update_id, text) => ({ update_id, message: { text, date: Math.floor(now / 1000), from: { id: 12345, is_bot: false }, chat: { id: 12345, type: 'private' } } });
      const click = async (update_id, action) => {
        const msg = messages.at(-1), data = msg.reply_markup.inline_keyboard.flat().find(button => button.callback_data.endsWith(':' + action)).callback_data;
        await bot.handleUpdate({ update_id, callback_query: { id: 'desktop-' + update_id, data, from: { id: 12345, is_bot: false }, message: { message_id: msg.message_id, chat: { id: 12345, type: 'private' } } } });
      };
      await bot.handleUpdate(message(1, '/start ' + pair.pairing.code));
      await bot.handleUpdate(message(2, '/add native | Tested in the bundled runtime'));
      if (db.read('notebook').notebook.words.length !== 0) return false;
      await click(3, 'save');
      await bot.handleUpdate(message(4, '/review'));
      await click(5, 'reveal'); await click(6, 'good');
      const notebook = db.read('notebook').notebook;
      return notebook.words.length === 1 && notebook.words[0].word === 'native' && notebook.reviews.length === 1 && notebook.reviews[0].direction === 'meaning';
    } finally { bot.stop(); await bot.idle(); db.close(); }
  })()`), true, 'Telegram operations must work inside the actual bundled Node/SQLite runtime');
  assert.deepEqual(await running.evaluate(`({ node: typeof window.require, process: typeof window.process, electron: typeof window.electron })`), { node: 'undefined', process: 'undefined', electron: 'undefined' });
  assert.equal(await running.evaluate(`document.querySelectorAll('[data-view="passage"]').length > 0`), true);
  assert.equal(await running.evaluate(`(async () => { const r = await fetch('/'); return r.headers.get('content-security-policy').includes("script-src 'self'") && r.headers.get('content-security-policy').includes("object-src 'none'"); })()`), true);
  const guards = await running.evaluate(`(async () => {
    const statuses = [];
    for (const url of ['/data/wordwell.sqlite', '/.env', '/server.mjs', '/%2e%2e%2f.env']) statuses.push((await fetch(url)).status);
    return statuses;
  })()`);
  assert.deepEqual(guards, [404, 404, 404, 403]);
  assert.equal(await running.evaluate(`(async () => { const s = await (await fetch('/api/settings/telegram')).json(); return s.desktop === true && s.enabled === false && s.hasToken === false && s.allowAI === false && s.keepRunningTray === false; })()`), true);
  assert.equal(await running.evaluate(`(async () => { const r = await fetch('/data/telegram-settings.json'); return r.status === 404; })()`), true);
  assert.equal(await running.evaluate(`(async () => { try { await fetch('file:///C:/Windows/win.ini'); return false; } catch { return true; } })()`), true);
  assert.equal(await running.evaluate(`window.open('file:///C:/Windows/win.ini') === null`), true);
  assert.equal(await running.evaluate(`(async () => { const r = await fetch('/api/settings/ai'); const s = await r.json(); return s.configured === false && s.allowKeyReveal === false; })()`), true);
  assert.equal(await running.evaluate(`(async () => {
    document.querySelector('#settings-skip').click();
    for (let i = 0; i < 50 && document.querySelector('[data-view="today"]').getAttribute('aria-current') !== 'page'; i++) await new Promise(resolve => setTimeout(resolve, 50));
    document.querySelector('#word').value = 'portable';
    document.querySelector('#meaning').value = 'Easy to carry.\\n-> Có thể mang theo';
    document.querySelector('#pronunciation').value = '/ˈpɔː.tə.bəl/';
    document.querySelector('#synonyms').value = 'transportable, mobile';
    document.querySelector('#example').value = 'City reservoirs emptied faster than anyone had planned for.\\nIn one state capital, they fell below a quarter full.';
    document.querySelector('#note').value = 'Listening transcript\\n\\nLearn now: High-utility vocabulary for IELTS Listening and Reading topics dealing with climate, drought, and urban utilities.';
    document.querySelector('#add-form').requestSubmit();
    for (let i = 0; i < 100; i++) {
      const s = await (await fetch('/api/storage/notebook')).json();
      if (s.notebook.words.length === 1) return s.notebook.words[0].word === 'portable';
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  })()`), true);
  const screenshot = await running.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(home, 'desktop.png'), Buffer.from(screenshot.data, 'base64'));
  assert.equal(await running.evaluate(`(() => {
    const initial = document.documentElement.dataset.theme;
    document.querySelector('#theme-toggle').click();
    const toggled = document.documentElement.dataset.theme;
    document.querySelector('#theme-toggle').click();
    return Boolean(initial) && toggled !== initial && document.documentElement.dataset.theme === initial && document.querySelectorAll('#recent-words .mastery-pips i').length === 4;
  })()`), true);
  assert.equal(await running.evaluate(`(() => {
    document.querySelector('#start-review').click();
    document.querySelector('[data-action="reveal"]').click();
    const dialog = document.querySelector('#review-dialog');
    const header = dialog.querySelector('.review-header').getBoundingClientRect();
    const body = dialog.querySelector('.review-body').getBoundingClientRect();
    const word = dialog.querySelector('.review-word').getBoundingClientRect();
    const good = dialog.querySelector('[data-rating="good"]').getBoundingClientRect();
    const dialogBox = dialog.getBoundingClientRect();
    const visible = dialog.scrollTop === 0 && header.top >= dialogBox.top - 1 && word.top >= body.top && good.bottom <= dialogBox.bottom + 1;
    dialog.querySelector('[data-action="exit-review"]').click();
    document.querySelector('#confirm-actions .button.primary').click();
    return visible && !dialog.open;
  })()`), true, 'revealing a full flashcard must not clip the header, word title, or rating buttons');
  assert.equal(await running.evaluate(`(async () => {
    document.querySelector('[data-view="writing"]').click();
    for (const [id, text] of [['writing-question', 'Discuss the benefits of portable learning.'], ['writing-essay', 'A portable notebook makes it easier to practice every day.']]) {
      const field = document.getElementById(id); field.value = text; field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    for (let i = 0; i < 100; i++) {
      const s = await (await fetch('/api/storage/writing')).json();
      if (s.draft?.essay === 'A portable notebook makes it easier to practice every day.' && document.querySelector('#writing-save-status').textContent.startsWith('Saved')) return document.querySelector('#writing-word-bar')?.style.width === '4%';
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  })()`), true);
  assert.equal(await running.evaluate(`(async () => { const r = await fetch('/api/storage/backup'); const b = new Uint8Array(await r.arrayBuffer()); return r.ok && new TextDecoder().decode(b.slice(0, 15)) === 'SQLite format 3'; })()`), true);
  assert.equal(await running.evaluate(`(async () => {
    document.querySelector('[data-view="telegram"]').click();
    for (let i = 0; i < 100 && document.querySelector('#telegram-fields').disabled; i++) await new Promise(resolve => setTimeout(resolve, 50));
    const background = document.querySelector('#telegram-background'); background.checked = true; background.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#telegram-form').requestSubmit();
    for (let i = 0; i < 100; i++) {
      const state = await (await fetch('/api/settings/telegram')).json();
      if (state.keepRunningTray === true && document.querySelector('#telegram-status').textContent.includes('saved')) return state.enabled === false && state.hasToken === false;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  })()`), true);
  const telegramScreenshot = await running.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(home, 'telegram-desktop.png'), Buffer.from(telegramScreenshot.data, 'base64'));
  assert.equal(await running.evaluateMain(`(() => { const e = process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app.asar/package.json')('electron'); const window = e.BrowserWindow.getAllWindows()[0]; window.close(); return e.BrowserWindow.getAllWindows().length === 1 && !window.isVisible(); })()`), true);
  await pause(500);
  assert.equal(await running.evaluate(`(async () => (await fetch('/api/storage/notebook')).ok)()`), true, 'closing to the tray must retain the renderer and database server');
  assert.deepEqual(running.exceptions, []);
  await running.stop(); running = null;
  assert.ok(existsSync(path.join(home, 'data/wordwell.sqlite')));
  assert.equal(JSON.parse(readFileSync(path.join(home, 'data/ai-settings.json'), 'utf8')).setupDismissed, true);
  running = await launch(executable);
  assert.equal(await running.evaluate(`(async () => { const s = await (await fetch('/api/storage/notebook')).json(); return s.notebook.words.length === 1 && s.notebook.words[0].word === 'portable' && Boolean(s.notebook.words[0].production); })()`), true);
  assert.equal(await running.evaluate(`document.querySelector('#nav-total').textContent.trim()`), '1');
  assert.equal(await running.evaluate(`(async () => {
    for (let i = 0; i < 100; i++) {
      if (document.querySelector('#writing-essay').value === 'A portable notebook makes it easier to practice every day.') return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  })()`), true);
  await running.stop(); running = null;
  // Exercise the actual self-extracting executable too, including its automatic
  // PORTABLE_EXECUTABLE_DIR handoff. The full data folder must remain beside it.
  const version = require('../package.json').version;
  const artifact = path.join(release, `Wordwell-${version}-portable-x64.exe`);
  assert.ok(existsSync(artifact));
  const copy = path.join(home, 'Wordwell.exe'); copyFileSync(artifact, copy);
  running = await launch(copy, { overrideHome: false });
  assert.equal(await running.evaluate(`(async () => { const s = await (await fetch('/api/storage/notebook')).json(); return s.notebook.words[0]?.word === 'portable'; })()`), true);
  assert.deepEqual(running.exceptions, []);
  await running.stop(); running = null;
  console.log('PASS: real packaged UI, Telegram add/review in bundled Node with a mock transport, close-to-tray and native quit, manual card saving, notebook and Writing persistence after restart, SQLite backup, portable data-directory handoff, renderer isolation, CSP, private paths/traversal and blocked file URLs. No real Telegram or paid AI requests.');
  console.log(`Isolated QA data and screenshot: ${home}`);
})().catch(async error => {
  console.error(error.stack);
  if (running) await running.stop().catch(() => {});
  process.exitCode = 1;
});

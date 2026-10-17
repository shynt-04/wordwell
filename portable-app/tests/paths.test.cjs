const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { portablePaths, isApplicationUrl, isReferenceUrl, shouldHideToTray } = require('../src/paths.cjs');

test('development data stays separate from the existing website', () => {
  const source = path.resolve('portable-app/src');
  const paths = portablePaths({ packaged: false, sourceDirectory: source, portableDirectory: path.resolve('ignored-extractor') });
  assert.equal(paths.data, path.resolve('portable-app/data'));
  assert.equal(paths.database, path.join(paths.data, 'wordwell.sqlite'));
  assert.notEqual(paths.database, path.resolve('data/wordwell.sqlite'));
});
test('portable builds use the original executable directory, not extracted files', () => {
  const home = path.resolve('portable copy with spaces');
  const paths = portablePaths({ packaged: true, executable: path.resolve('temporary/Wordwell.exe'), portableDirectory: home });
  assert.equal(paths.home, home);
  assert.equal(paths.settings, path.join(home, 'data/ai-settings.json'));
  assert.equal(paths.browser, path.join(home, 'data/browser'));
  assert.equal(paths.config, path.join(home, '.env'));
});
test('unpacked applications keep data beside the executable', () => {
  const executable = path.resolve('release/win-unpacked/Wordwell.exe');
  assert.equal(portablePaths({ packaged: true, executable }).data, path.join(path.dirname(executable), 'data'));
});
test('navigation permits only the local application page', () => {
  const origin = 'http://127.0.0.1:49231';
  for (const url of [`${origin}/`, `${origin}/index.html`, `${origin}/#today`]) assert.equal(isApplicationUrl(url, origin), true);
  for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', `${origin}/api/settings/ai/key`, 'https://example.com/', 'http://127.0.0.1:49232/', `${origin.replace('://', '://user:pass@')}/`, 'bad url']) assert.equal(isApplicationUrl(url, origin), false);
});
test('external links allow only the fixed IELTS reference, not OS handlers or AI URLs', () => {
  assert.equal(isReferenceUrl('https://ielts.org/take-a-test/preparation-resources/writing-test-resources'), true);
  for (const url of ['https://ielts.org.evil.test/', 'https://ielts.org/other', 'https://ielts.org/take-a-test/preparation-resources/writing-test-resources?next=evil', 'file:///C:/Windows/win.ini', 'ms-settings:', 'https://example.com']) assert.equal(isReferenceUrl(url), false);
});
test('tray closing is opt-in and must not intercept an explicit quit or missing tray', () => {
  assert.equal(shouldHideToTray({ keepRunningTray: true, quitting: false, hasTray: true }), true);
  for (const options of [{ keepRunningTray: false, quitting: false, hasTray: true }, { keepRunningTray: true, quitting: true, hasTray: true }, { keepRunningTray: true, quitting: false, hasTray: false }, {}]) assert.equal(shouldHideToTray(options), false);
});

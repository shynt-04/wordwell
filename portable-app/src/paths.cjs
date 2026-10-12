const path = require('node:path');

function portablePaths({ packaged, executable, sourceDirectory, portableDirectory }) {
  // NSIS extracts the runtime to a temporary directory. Keep personal data at
  // the original executable location, never inside that temporary runtime.
  const home = packaged
    ? (portableDirectory ? path.resolve(portableDirectory) : path.dirname(executable))
    : path.resolve(sourceDirectory, '..');
  const data = path.join(home, 'data');
  return { home, data, database: path.join(data, 'wordwell.sqlite'), settings: path.join(data, 'ai-settings.json'), browser: path.join(data, 'browser'), config: path.join(home, '.env') };
}

function isApplicationUrl(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password && ['/', '/index.html'].includes(url.pathname);
  } catch { return false; }
}

function isReferenceUrl(value) {
  // Only this fixed, trusted link is opened outside the app. Never pass arbitrary
  // AI output, custom endpoints, file paths, or OS protocol handlers to the shell.
  try {
    const url = new URL(value);
    return url.href === 'https://ielts.org/take-a-test/preparation-resources/writing-test-resources';
  } catch { return false; }
}

module.exports = { portablePaths, isApplicationUrl, isReferenceUrl };

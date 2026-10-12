const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../package.json');
const website = require('../../package.json');

test('portable packaging bundles only reusable source and license resources, never credentials or notebooks', () => {
  assert.equal(config.version, website.version);
  assert.equal(config.build.asar, true);
  assert.deepEqual(config.build.files, ['src/**/*.cjs', 'package.json']);
  assert.deepEqual(config.build.extraResources.map(resource => resource.from), ['../vocab-app', '../package.json', '../LICENSE', 'build/wordwell.ico']);
  assert.deepEqual(config.build.extraResources[0].filter, ['*.mjs', 'dist/*.html', 'dist/*.css', 'dist/*.js']);
  assert.deepEqual(config.build.win.target, [{ target: 'portable', arch: ['x64'] }]);
  assert.equal(config.build.portable.requestExecutionLevel, 'user');
  assert.equal(config.dependencies, undefined, 'no third-party packages shipped as runtime Node dependencies');
});

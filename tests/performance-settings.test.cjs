const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('periodic list refresh setting is removed and autoload has a bounded default', () => {
  const shared = fs.readFileSync('shared.js', 'utf8');
  const context = vm.createContext({});
  vm.runInContext(shared, context, { filename: path.resolve('shared.js') });
  assert.equal(context.YOUSUB.DEFAULTS.autoloadLimit, 250);
  assert.equal('autoSyncHours' in context.YOUSUB.DEFAULTS, false);
  const ui = fs.readFileSync('popup/popup.html', 'utf8');
  assert.doesNotMatch(ui, /autoSyncHours|Automatically refresh the list/);
  for (const v of [0, 100, 250, 500]) assert.match(ui, new RegExp(`value="${v}"`));
  const content = fs.readFileSync('content/content.js', 'utf8');
  assert.doesNotMatch(content, /autoSyncHours|const stale =/);
  assert.match(content, /\[0, 100, 250, 500\]\.includes\(settings\.autoloadLimit\)/);
  assert.match(content, /otherAccount \|\| oldFormat \|\| !subs\.ts/);
});

test('state messages replace frequent polling while preserving a fallback', () => {
  const popup = fs.readFileSync('popup/popup.js', 'utf8');
  const content = fs.readFileSync('content/content.js', 'utf8');
  assert.match(popup, /yousubStateChanged/);
  assert.match(content, /type: 'yousubStateChanged'/);
  assert.doesNotMatch(popup, /setInterval\(async[^\n]*700/);
  assert.match(popup, /30000/);
  assert.match(content, /\(page \|\| document\)\.querySelectorAll\(CARD_SEL\)/);
  assert.match(content, /!document\.hidden/);
  assert.match(fs.readFileSync('content/main-world.js', 'utf8'), /!document\.hidden/);
});

test('Drive sync has no timer, no page-load pull, and no run at browser start', () => {
  const background = fs.readFileSync('background.js', 'utf8');
  const content = fs.readFileSync('content/content.js', 'utf8');
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  assert.doesNotMatch(background, /chrome\.alarms|SYNC_ALARM|onStartup|drivePull|lastPull/);
  assert.doesNotMatch(content, /drivePull/);
  assert.equal(manifest.permissions.includes('alarms'), false, 'the alarms permission is not requested');
  // The two triggers that remain: a debounced push after a local change, and install/update.
  assert.match(background, /pushTimer = setTimeout\(\(\) => Drive\.sync\(\), 3000\)/);
  assert.match(background, /chrome\.runtime\.onInstalled\.addListener[\s\S]*?Drive\.sync\(\)/);
});

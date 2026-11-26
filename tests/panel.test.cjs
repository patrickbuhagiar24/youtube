// The side panel is the extension's only interface, and its failures are silent ones: a button
// wired to nothing, a form that opens on every visit, a cached configuration read twice. These
// tests load the real popup.html with the real popup.js, shared.js, drive.js and config-file.js
// inside jsdom, with a small chrome.* stand-in that keeps storage in memory, and then drive the
// page the way a person does — clicking buttons, picking a file, reopening the panel.
//
// jsdom only covers the page. The network, chrome.identity and Google are not involved: the worker
// is represented by whatever the test makes sendMessage answer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, afterEach } = require('node:test');
const { JSDOM } = jsdomModule();

function jsdomModule() {
  try {
    return require('jsdom');
  } catch {
    throw new Error('jsdom is missing: run "npm install" once (the extension itself has no dependencies)');
  }
}

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'popup/popup.html'), 'utf8');
// Let the panel finish the promise chain a click starts. A service worker answers instantly; how
// slow one is in real life is not what these tests are about.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const CONFIG_KEY = 'yousubDriveConfig';

// popup.js polls the active tab every 30 seconds; a panel left open would keep the test runner
// alive. Every panel opened here is closed when its test ends.
const opened = [];
afterEach(() => { for (const window of opened.splice(0)) window.close(); });

/** A chrome.* stand-in: storage in memory, messages recorded, no YouTube tab. */
function fakeChrome({ storage = {}, onMessage } = {}) {
  const local = { ...storage };
  const sync = {};
  const sent = [];
  const changed = [];
  const area = (bag) => ({
    get: async (keys) => {
      const list = keys == null ? Object.keys(bag) : [].concat(keys);
      const out = {};
      for (const key of list) if (key in bag) out[key] = JSON.parse(JSON.stringify(bag[key]));
      return out;
    },
    set: async (values) => {
      Object.assign(bag, JSON.parse(JSON.stringify(values)));
      for (const listener of changed) {
        listener(Object.fromEntries(Object.keys(values).map((key) => [key, { newValue: bag[key] }])), 'local');
      }
    },
    remove: async (keys) => { for (const key of [].concat(keys)) delete bag[key]; }
  });
  const chrome = {
    runtime: {
      getManifest: () => ({ version: '2.7.1' }),
      // Messages cross the jsdom realm boundary; keep Node copies so assertions can compare them.
      sendMessage: async (message) => {
        const copy = JSON.parse(JSON.stringify(message));
        sent.push(copy);
        return onMessage ? onMessage(copy) : { ok: true };
      },
      onMessage: { addListener: () => {} }
    },
    storage: {
      local: area(local),
      sync: area(sync),
      onChanged: { addListener: (fn) => changed.push(fn) }
    },
    tabs: {
      query: async () => [], // No YouTube tab: the summary stays on its stored value.
      sendMessage: async () => null,
      create: () => {},
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} }
    }
  };
  return { chrome, local, sync, sent };
}

/** Open the panel. Returns the DOM plus a helper that clicks by element id. */
async function openPanel({ storage, onMessage, filePicker } = {}) {
  const fake = fakeChrome({ storage, onMessage });
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://yousub.test/', pretendToBeVisual: true });
  const { window } = dom;
  opened.push(window);
  // The page scripts run inside the window, so chrome and the picker belong to the window.
  window.chrome = fake.chrome;
  if (filePicker) window.showOpenFilePicker = filePicker;
  // Run the page scripts in the window's own context, naming each file: the name is what lets the
  // test runner attribute coverage to the real files instead of an anonymous eval.
  const pageContext = dom.getInternalVMContext();
  for (const file of ['shared.js', 'drive.js', 'config-file.js', 'popup/popup.js']) {
    const abs = path.join(root, file);
    vm.runInContext(fs.readFileSync(abs, 'utf8'), pageContext, { filename: abs });
  }
  await settle();
  const $ = (id) => window.document.getElementById(id);
  return { dom, window, $, fake, click: async (id) => { $(id).click(); await settle(); } };
}

// What the picker hands back: a handle whose getFile() resolves a File-like object.
const handle = (file) => ({ kind: 'file', name: file.name, getFile: async () => file });
const configFile = (record, name = 'yousub-config.json') => handle({
  name,
  size: JSON.stringify(record).length,
  text: async () => JSON.stringify(record)
});

const validConfig = {
  'yousub-file': 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view?usp=sharing',
  client_id: '1234567890-abc123.apps.googleusercontent.com'
};

test('a fresh panel offers one configuration button and no sign-out', async () => {
  const panel = await openPanel();
  assert.equal(panel.$('googleSetup'), null, 'the form is gone');
  assert.equal(panel.$('setupStatus').textContent, '');
  assert.match(panel.$('driveStatus').textContent, /only while Google Drive sync is configured/);
  assert.equal(panel.$('driveSetupBtn').classList.contains('configured'), false);
  // The panel no longer tells the reader to open YouTube.
  assert.doesNotMatch(panel.$('status').textContent, /Open youtube\.com|Waiting for this YouTube tab/);
  assert.deepEqual(Object.keys(panel.fake.local), [], 'nothing is written before a file is picked');
  assert.deepEqual(panel.fake.sent, [], 'no Google message is sent before a file is picked');
});

test('the Configuration file button opens the picker directly', async () => {
  let pickers = 0;
  const panel = await openPanel({ filePicker: async () => { pickers += 1; throw Object.assign(new Error('closed'), { name: 'AbortError' }); } });
  await panel.click('driveSetupBtn');
  assert.equal(pickers, 1, 'one click, one picker: no form in between');
  // Closing the picker is not an error and leaves no message behind.
  assert.equal(panel.$('setupStatus').textContent, '');
});

test('a picked file is validated, cached, and used to ask the worker to sign in', async () => {
  const panel = await openPanel({
    filePicker: async () => [configFile(validConfig)],
    onMessage: (message) => ({ ok: true, mode: message.signIn ? 'refresh token' : '' })
  });
  await panel.click('driveSetupBtn');
  const cached = panel.fake.local[CONFIG_KEY];
  assert.ok(cached, 'the configuration is cached');
  assert.equal(cached.clientId, validConfig.client_id);
  assert.equal(cached.link, validConfig['yousub-file']);
  assert.equal(cached.clientSecret, '');
  assert.equal(cached.file, 'yousub-config.json');
  assert.equal(cached.version, 1);
  assert.equal(cached.savedAt.length > 0, true);
  assert.deepEqual(panel.fake.sent, [{ type: 'driveSync', signIn: true }], 'one sign-in request, no polling');
  assert.match(panel.$('setupStatus').textContent, /^✅ Saved\./);
  // The details live in the tooltip of the one button that remains.
  assert.match(panel.$('driveSetupBtn').title, /yousub-config\.json/);
  assert.match(panel.$('driveSetupBtn').title, /Google session mode/);
  assert.equal(panel.$('driveSetupBtn').classList.contains('configured'), true);
});

test('a file with no secret keeps the token out of the panel path, a file with one is marked as such', async () => {
  const withSecret = { ...validConfig, client_secret: 'GOCSPX-abcdefghijklmnop' };
  const panel = await openPanel({ filePicker: async () => [configFile(withSecret, 'drive.json')] });
  await panel.click('driveSetupBtn');
  assert.equal(panel.fake.local[CONFIG_KEY].clientSecret, 'GOCSPX-abcdefghijklmnop');
  assert.match(panel.$('driveSetupBtn').title, /drive\.json/);
  assert.match(panel.$('driveSetupBtn').title, /client secret stored/);
  assert.match(panel.$('setupStatus').textContent, /Google Drive sync runs in the background/);
});

test('reopening the panel reads the cache and never asks for the file again', async () => {
  const first = await openPanel({ filePicker: async () => [configFile(validConfig)] });
  await first.click('driveSetupBtn');
  const cached = structuredClone(first.fake.local[CONFIG_KEY]);

  let pickers = 0;
  const second = await openPanel({
    storage: { [CONFIG_KEY]: cached },
    filePicker: async () => { pickers += 1; return [configFile(validConfig)]; }
  });
  assert.equal(pickers, 0, 'the picker is not opened');
  assert.match(second.$('driveSetupBtn').title, /yousub-config\.json/);
  assert.deepEqual(second.fake.local[CONFIG_KEY], cached, 'the cache is left byte for byte as it was');
  assert.deepEqual(second.fake.sent, [], 'reopening does not sign in again');
  assert.equal(second.$('driveSetupBtn').classList.contains('configured'), true);
});

test('a broken file reports every problem at once and never replaces a working cache', async () => {
  const good = { ...validConfig, clientSecret: '', file: 'good.json', savedAt: '2026-11-01T00:00:00.000Z', version: 1 };
  const broken = { 'yousub-file': 'https://drive.google.com/drive/folders/abc', client_id: 'not-a-client' };
  const panel = await openPanel({ storage: { [CONFIG_KEY]: good }, filePicker: async () => [configFile(broken, 'broken.json')] });
  await panel.click('driveSetupBtn');
  const status = panel.$('setupStatus').textContent;
  assert.match(status, /folder/, 'the folder link is named');
  assert.match(status, /client_id.*apps\.googleusercontent\.com/, 'the client id is named');
  assert.equal(status.includes(';'), true, 'both problems arrive in one message');
  assert.deepEqual(panel.fake.local[CONFIG_KEY], good, 'the working configuration survives');
  assert.deepEqual(panel.fake.sent, [], 'a rejected file does not start a sign-in');
});

test('a file that is not JSON is reported by name', async () => {
  const panel = await openPanel({
    filePicker: async () => [handle({ name: 'notes.json', size: 9, text: async () => 'not json' })]
  });
  await panel.click('driveSetupBtn');
  assert.match(panel.$('setupStatus').textContent, /^⚠️ notes\.json is not valid JSON\.$/);
  assert.equal(panel.fake.local[CONFIG_KEY], undefined);
});

test('a browser without a file picker says so instead of failing silently', async () => {
  const panel = await openPanel();
  assert.equal(panel.window.showOpenFilePicker, undefined);
  await panel.click('driveSetupBtn');
  assert.match(panel.$('setupStatus').textContent, /cannot open a file picker/);
});

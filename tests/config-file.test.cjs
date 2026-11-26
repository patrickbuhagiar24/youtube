// Guards the one-file configuration: two required keys, an optional secret, every problem reported
// at once, and a versioned cache record that decides whether the file is needed again.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function load() {
  const context = vm.createContext({ JSON, Date });
  // The filename lets the test runner attribute V8 coverage to the real file.
  vm.runInContext(fs.readFileSync('config-file.js', 'utf8'), context, { filename: path.resolve('config-file.js') });
  return context.YousubConfigFile;
}

const file = (name, text, size) => ({ name, size: size ?? text.length, text: async () => text });
const valid = { 'yousub-file': 'https://drive.google.com/file/d/abcdefghij1234567890/view', client_id: '1234567890-abc.apps.googleusercontent.com' };

test('reads the two required keys and caches a versioned record', async () => {
  const api = load();
  const record = await api.read(file('yousub-config.json', JSON.stringify(valid)));
  assert.equal(record.link, valid['yousub-file']);
  assert.equal(record.clientId, valid.client_id);
  assert.equal(record.clientSecret, '', 'the secret is optional');
  assert.equal(record.file, 'yousub-config.json');
  assert.equal(record.version, 1);
  assert.ok(record.savedAt);
  assert.equal(api.usable(record), true);
});

test('keeps an optional client secret when the file has one', async () => {
  const api = load();
  const record = await api.read(file('c.json', JSON.stringify({ ...valid, client_secret: 'GOCSPX-a-long-secret' })));
  assert.equal(record.clientSecret, 'GOCSPX-a-long-secret');
  assert.equal(api.describe(record).hasSecret, true);
});

test('names every problem at once instead of one per attempt', async () => {
  const api = load();
  await assert.rejects(api.read(file('x.json', '{}')), (e) => {
    assert.match(e.message, /needs "yousub-file"/);
    assert.match(e.message, /needs "client_id"/);
    return true;
  });
  // A folder link, a non-Drive link and a bad client id are all listed together.
  await assert.rejects(
    api.read(file('x.json', JSON.stringify({
      'yousub-file': 'https://drive.google.com/drive/folders/abc',
      client_id: 'not-a-client'
    }))),
    (e) => {
      assert.match(e.message, /points to a folder/);
      assert.match(e.message, /apps\.googleusercontent\.com/);
      return true;
    }
  );
  await assert.rejects(api.read(file('x.json', JSON.stringify({ ...valid, 'yousub-file': 'not a link' }))), /not a Google Drive file link/);
});

test('rejects broken, oversized and non-object files with the file name', async () => {
  const api = load();
  await assert.rejects(api.read(file('broken.json', '{not json')), /broken\.json is not valid JSON/);
  await assert.rejects(api.read(file('array.json', '[]')), /array\.json must contain a JSON object/);
  await assert.rejects(api.read(file('huge.json', JSON.stringify(valid), 300 * 1024)), /huge\.json is too large/);
  await assert.rejects(api.read(null), /No file was chosen/);
});

test('an older or damaged cache record asks for the file again', () => {
  const api = load();
  assert.equal(api.usable({ version: 1, clientId: 'a', link: 'b' }), true);
  assert.equal(api.usable({ version: 0, clientId: 'a', link: 'b' }), false);
  assert.equal(api.usable({ clientId: 'a', link: 'b' }), false);
  assert.equal(api.usable({ version: 1, clientId: 'a' }), false);
  assert.equal(api.usable(null), false);
  assert.deepEqual({ ...api.describe({}) }, { configured: false });
});

test('the loader never reads a folder and never invents keys', () => {
  const source = fs.readFileSync('config-file.js', 'utf8');
  assert.doesNotMatch(source, /showDirectoryPicker|values\(\)|getDirectoryHandle/);
  assert.match(source, /const LINK_KEY = 'yousub-file'/);
  assert.match(source, /const CLIENT_KEY = 'client_id'/);
  assert.match(source, /const SECRET_KEY = 'client_secret'/);
});

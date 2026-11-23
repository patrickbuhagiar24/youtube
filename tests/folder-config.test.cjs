const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const DRIVE = JSON.stringify({ link: 'https://drive.google.com/file/d/target/view' });
const KEY = JSON.stringify({ type: 'service_account', client_email: 'sa@example.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----' });

/** Build the API in a sandbox; IndexedDB is not needed for the scanning tests. */
function load() {
  const context = vm.createContext({ JSON, URL, indexedDB: undefined });
  vm.runInContext(fs.readFileSync('folder-config.js', 'utf8'), context);
  return context.YousubFolder;
}

/** A folder-like object: { values() } yielding entries like the File System Access API does. */
function dir(name, entries) {
  return { name, values: async function* () { for (const e of entries) yield e; } };
}
const file = (name, text) => ({ kind: 'file', name, getFile: async () => ({ size: text.length, text: async () => text }) });

test('finds both files by their content, whatever their names are', async () => {
  const api = load();
  const folder = dir('my-config', [file('key (1).json', KEY), file('notes.txt', 'hello'), file('drive.json', DRIVE)]);
  let validatedKey = '';
  const config = await api.read(folder, Object.assign((text) => JSON.parse(text).link, { key: (text) => { validatedKey = text; } }));
  assert.equal(config.link, 'https://drive.google.com/file/d/target/view');
  assert.equal(JSON.parse(config.keyText).client_email, 'sa@example.iam.gserviceaccount.com');
  assert.equal(config.folder, 'my-config');
  // Objects created inside the sandbox have another prototype; compare their values.
  assert.deepEqual({ ...config.files }, { serviceAccount: 'key (1).json', drive: 'drive.json' });
  assert.match(validatedKey, /service_account/);
});

test('prefers the documented file names and reads only the top level', async () => {
  const api = load();
  const folder = dir('config', [
    // A sub-folder is never entered: the same file inside it must not be used.
    { kind: 'directory', name: 'nested', values: dir('nested', [file('yousub-google-drive.json', DRIVE)]).values },
    file('other.json', JSON.stringify({ type: 'service_account', client_email: 'a@b.c', private_key: 'k' })),
    file('service-account.json', KEY),
    file('yousub-google-drive.json', DRIVE)
  ]);
  const config = await api.read(folder, (text) => JSON.parse(text).link);
  assert.equal(config.files.serviceAccount, 'service-account.json', 'the documented key wins');
  assert.equal(config.files.drive, 'yousub-google-drive.json');
  // With the file only inside a sub-folder, it counts as missing.
  const nestedOnly = dir('config2', [
    { kind: 'directory', name: 'nested', values: dir('nested', [file('yousub-google-drive.json', DRIVE)]).values },
    file('service-account.json', KEY)
  ]);
  await assert.rejects(api.read(nestedOnly, (t) => JSON.parse(t).link), /Missing JSON file: yousub-google-drive\.json/);
});

test('names exactly which JSON file is missing', async () => {
  const api = load();
  const read = (folder) => api.read(folder, (t) => JSON.parse(t).link);
  // Only the key present -> the Drive file is the one that is missing (and vice versa).
  await assert.rejects(read(dir('x', [file('only.json', DRIVE)])), /Missing JSON file: service-account\.json\./);
  await assert.rejects(read(dir('x', [file('only.json', KEY)])), /Missing JSON file: yousub-google-drive\.json\./);
  // Nothing usable -> both are named, with what was found instead.
  await assert.rejects(read(dir('x', [file('a.txt', 'x')])), /Missing JSON files: service-account\.json and yousub-google-drive\.json\./);
  await assert.rejects(read(dir('x', [file('a.txt', 'x')])), /No JSON file was found there\./);
  await assert.rejects(read(dir('x', [file('other.json', '{"hello":1}')])), /Found instead: other\.json\./);
});

test('ignores unreadable files, oversized files and non-JSON folders', async () => {
  const api = load();
  const broken = { kind: 'file', name: 'broken.json', getFile: async () => { throw new Error('denied'); } };
  const huge = { kind: 'file', name: 'huge.json', getFile: async () => ({ size: 10 * 1024 * 1024, text: async () => DRIVE }) };
  const folder = dir('x', [broken, huge, file('drive.json', DRIVE), file('key.json', KEY)]);
  const config = await api.read(folder, (t) => JSON.parse(t).link);
  assert.equal(config.files.serviceAccount, 'key.json');
});

test('the folder is not decoded as a manifest of links', () => {
  const api = load();
  const js = fs.readFileSync('folder-config.js', 'utf8');
  // A link-list manifest (the old format) is not what is read any more
  assert.equal(api.parse(JSON.stringify({ 'yousub-google-drive.json': 'https://drive.google.com/file/d/x/view' })), null);
  assert.equal(api.parse(DRIVE).role, 'drive');
  assert.equal(api.parse(KEY).role, 'service-account');
  assert.doesNotMatch(js, /YousubManifest/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(chrome = {}, fetch = async () => ({ ok: false }), cryptoImpl = crypto) {
  const context = vm.createContext({ chrome, fetch, URL, URLSearchParams, TextEncoder, crypto: cryptoImpl, btoa, atob, console });
  vm.runInContext(fs.readFileSync('shared.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('drive.js', 'utf8'), context);
  return context;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const id = 'UCabcdefghijklmnopqrstuv';
const now = Date.now();
const configPath = '/home/test/.config/yt-unsub-detector/google-drive.json';
const keyPath = '/home/test/.config/yt-unsub-detector/service-account.json';
const key = { type: 'service_account', client_email: 'test@example.invalid', private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----' };

test('Drive exports use English fields and round-trip both event types', () => {
  const { Drive } = load();
  const events = { [id]: { s: 'unsub', at: now, title: 'Example', url: '/@example' } };
  const text = Drive.toFile(events);
  const data = JSON.parse(text);
  assert.equal(data.application, 'YT Unsub Detector');
  assert.equal(data.unsubscribeCount, 1);
  assert.equal(data.channels[0].name, 'Example');
  assert.equal(data.channels[0].url, 'https://www.youtube.com/@example');
  assert.equal(data.channels[0].status, 'unsubscribed');
  assert.ok(data.updatedAt && data.description && data.channels[0].date);
  assert.deepEqual(plain(Drive.fromFile(text)[id]), { ...events[id], url: 'https://www.youtube.com/@example' });
  assert.equal(Drive.fromFile(Drive.toFile({ [id]: { ...events[id], s: 'resub' } }))[id].s, 'resub');
});

test('only the English Drive format is read', () => {
  const { Drive } = load();
  const text = JSON.stringify({ channels: [{ id, date: new Date(now).toISOString(), status: 'resubscribed', name: 'English channel', url: '/@english' }] });
  assert.deepEqual(plain(Drive.fromFile(text)[id]), { s: 'resub', at: now, title: 'English channel', url: '/@english' });
  const unknown = JSON.stringify({ channels: [{ id, timestamp: new Date(now).toISOString(), state: 'resubscribed', title: 'Unknown', href: '/@unknown' }] });
  assert.deepEqual(plain(Drive.fromFile(unknown)), {});
});

test('invalid and empty files remain empty; malformed channel rows are ignored', () => {
  const { Drive } = load();
  assert.deepEqual(plain(Drive.fromFile('broken')), {});
  assert.deepEqual(plain(Drive.fromFile('')), {});
  assert.deepEqual(plain(Drive.fromFile('{"channels":[null,{}, {"id":"bad"}]}')), {});
});

test('newest event wins and empty remote data does not erase local history', () => {
  const { Drive } = load();
  const old = { [id]: { s: 'unsub', at: now - 1000, title: 'Old', url: '/@old' } };
  const recent = { [id]: { s: 'resub', at: now, title: '', url: '' } };
  const merged = Drive.merge(old, recent);
  assert.equal(merged[id].s, 'resub');
  assert.equal(merged[id].title, 'Old');
  assert.equal(merged[id].url, '/@old');
  assert.deepEqual(plain(Drive.merge({}, old)), old);
});

test('old resubscribe tombstones expire while unsubscribe history remains', () => {
  const { Drive } = load();
  const old = { s: 'resub', at: now - 181 * 864e5, title: '', url: '' };
  assert.deepEqual(plain(Drive.merge({ [id]: old })), {});
  assert.ok(Drive.merge({ [id]: { ...old, s: 'unsub' } })[id]);
});

test('file links are validated and placeholders remain disabled', () => {
  const { Drive } = load();
  assert.equal(Drive.fileIdOf('https://drive.google.com/file/d/abcdefghij1234567890/view'), 'abcdefghij1234567890');
  assert.equal(Drive.fileIdOf(''), '');
  assert.equal(Drive.fileIdOf('PASTE_FILE_LINK_HERE'), '');
  assert.throws(() => Drive.fileIdOf('https://drive.google.com/drive/folders/abc'), /google-drive\.json.*folder/);
  assert.throws(() => Drive.fileIdOf('not a link'), /google-drive\.json.*not a Google Drive file link/);
});

function nativeChrome(response, store = {}) {
  return {
    runtime: {
      lastError: null,
      sendNativeMessage: (_host, _message, callback) => callback(response),
    },
    storage: { local: {
      get: async (keys) => {
        if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]));
        return keys in store ? { [keys]: store[keys] } : {};
      },
      set: async (patch) => Object.assign(store, patch),
    } },
  };
}

test('unconfigured user files disable Drive without authentication errors', async () => {
  const store = {};
  const chrome = nativeChrome({ ok: true, configured: false, configPath, keyPath }, store);
  const { Drive } = load(chrome);
  assert.deepEqual(plain(await Drive.sync()), { ok: false, configured: false });
  assert.equal(store.ytucDrive.configured, false);
  assert.match(store.ytucDrive.configPath, /google-drive\.json$/);
});

test('a missing link points the user to google-drive.json', async () => {
  const chrome = nativeChrome({ ok: true, configured: true, link: '', key, configPath, keyPath });
  const { Drive } = load(chrome);
  const result = await Drive.sync();
  assert.equal(result.ok, false);
  assert.match(result.error, /Paste the YouTube\.json file link into .*google-drive\.json/);
});

test('missing key with a configured link produces an English error', async () => {
  const chrome = nativeChrome({ ok: true, configured: true, link: 'abcdefghij1234567890', key: null, configPath, keyPath });
  const { Drive } = load(chrome);
  const result = await Drive.sync();
  assert.equal(result.ok, false);
  assert.match(result.error, /key file .*service-account\.json.* is missing/);
});

test('missing native host produces an actionable APT error', async () => {
  const chrome = nativeChrome(null);
  chrome.runtime.sendNativeMessage = (_host, _message, callback) => {
    chrome.runtime.lastError = { message: 'Specified native messaging host not found.' };
    callback(null);
  };
  const { Drive } = load(chrome);
  const result = await Drive.sync();
  assert.equal(result.ok, false);
  assert.match(result.error, /APT package/);
});

test('a later sync re-reads user configuration after an unconfigured result', async () => {
  let response = { ok: true, configured: false, configPath, keyPath };
  let calls = 0;
  const chrome = nativeChrome(response);
  chrome.runtime.sendNativeMessage = (_host, _message, callback) => { calls += 1; callback(response); };
  const { Drive } = load(chrome);
  assert.deepEqual(plain(await Drive.sync()), { ok: false, configured: false });
  response = { ok: true, configured: true, link: 'abcdefghij1234567890', key: null, configPath, keyPath };
  const second = await Drive.sync();
  assert.equal(calls, 2);
  assert.equal(second.ok, false);
  assert.match(second.error, /key file .* is missing/);
});

test('a full sync preserves newer local events and writes English data', async () => {
  const secondId = 'UCbcdefghijklmnopqrstuvw';
  const remote = JSON.stringify({ channels: [
    { id, name: 'Remote channel', url: '/@remote', status: 'resubscribed', date: new Date(now - 1000).toISOString() }
  ] });
  const local = { [secondId]: { s: 'unsub', at: now, title: 'Local channel', url: '/@local' } };
  const store = { ytucUnsubs: local };
  const chrome = nativeChrome({ ok: true, configured: true, link: 'abcdefghij1234567890', key, configPath, keyPath }, store);
  let uploaded = '';
  const fetch = async (url, options = {}) => {
    if (url === 'https://oauth2.googleapis.com/token') return { ok: true, json: async () => ({ access_token: 'test-token', expires_in: 3600 }) };
    if (url.includes('fields=')) return { ok: true, json: async () => ({ name: 'YouTube.json', mimeType: 'application/json', capabilities: { canEdit: true } }) };
    if (url.includes('alt=media')) return { ok: true, text: async () => remote };
    if (url.includes('/upload/')) { uploaded = options.body; return { ok: true }; }
    throw new Error('Unexpected URL: ' + url);
  };
  const cryptoImpl = { subtle: { importKey: async () => ({}), sign: async () => new Uint8Array([1, 2, 3]) } };
  const { Drive } = load(chrome, fetch, cryptoImpl);
  assert.deepEqual(plain(await Drive.sync()), { ok: true });
  const data = JSON.parse(uploaded);
  assert.equal(data.unsubscribeCount, 1);
  assert.equal(data.channels.length, 2);
  assert.ok(data.channels.every((row) => row.name && row.date && ['unsubscribed', 'resubscribed'].includes(row.status)));
  assert.equal(store.ytucUnsubs[id].s, 'resub');
  assert.equal(store.ytucUnsubs[secondId].s, 'unsub');
  assert.equal(store.ytucDrive.lastError, '');
  assert.equal(store.ytucDrive.syncing, false);
});

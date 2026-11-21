const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function load() {
  const context = vm.createContext({ URL, TextEncoder, AbortController, setTimeout, clearTimeout, Drive: {
    linkFromConfig: (text) => JSON.parse(text).link,
    fileIdOf: (link) => { if (!link?.includes('/file/d/')) throw new Error('Invalid link'); return 'id'; },
    parseKey: (text) => { if (JSON.parse(text).type !== 'service_account') throw new Error('Invalid key'); }
  } });
  vm.runInContext(fs.readFileSync('config-manifest.js', 'utf8'), context);
  return context.YousubManifest;
}
const manifest = JSON.stringify({ 'yousub-google-drive.json': 'https://drive.google.com/file/d/config123/view?usp=sharing', 'service-account.json': 'https://drive.google.com/file/d/key123/view' });
const response = (text, status = 200) => ({ ok: status === 200, status, headers: { get: () => null }, text: async () => text });

test('loads and validates both linked files', async () => {
  const api = load(), seen = [];
  const result = await api.load(manifest, async (url, options) => {
    seen.push(url); assert.equal(options.credentials, 'omit');
    return response(url.includes('config123') ? '{"link":"https://drive.google.com/file/d/target/view"}' : '{"type":"service_account"}');
  });
  assert.equal(result.link, 'https://drive.google.com/file/d/target/view');
  assert.equal(JSON.parse(result.keyText).type, 'service_account');
  assert.equal(seen.length, 2);
});

test('rejects invalid manifests, unsafe links, inaccessible files and invalid keys', async () => {
  const api = load();
  assert.throws(() => api.parse('{}'), /Google Drive file link/);
  assert.throws(() => api.parse(manifest.replace('drive.google.com/file', 'evil.example/file')), /drive.google.com/ );
  await assert.rejects(api.load(manifest, async () => response('', 403)), /HTTP 403/);
  await assert.rejects(api.load(manifest, async () => response('<html>sign in</html>')), /not valid JSON/);
  await assert.rejects(api.load(manifest, async (url) => response(url.includes('config123') ? '{"link":"https://drive.google.com/file/d/target/view"}' : '{}')), /Invalid key/);
});

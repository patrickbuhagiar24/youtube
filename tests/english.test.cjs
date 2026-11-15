const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['.git', 'dist', 'artifacts', 'node_modules', '.venv', '.cache', '__pycache__', 'yt-unsub-detector'].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const isText = (file) => !/\.(?:png|jpg|jpeg|gif|ico|deb|dsc|xz|gz|gpg|asc|pem|key|zip|crx)$/.test(file)
  && file !== 'service-account.json';

test('project text declares English and has no legacy compatibility markers', () => {
  for (const file of walk('.')) {
    if (!isText(file) || file === 'tests/english.test.cjs') continue;
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /LEGACY_RESUB|LEGACY_PLACEHOLDERS|legacy-data-compat/, `Legacy compatibility marker remains in ${file}`);
    assert.doesNotMatch(text, /id-ID|localeCompare\([^)]*, 'id'\)/, `Non-English locale remains in ${file}`);
  }
  assert.ok(!fs.existsSync('drive-config.json'), 'The old drive-config.json template must not exist.');
});

test('manifest and popup declare English and all manifest assets exist', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  assert.equal(manifest.version, '1.21.0');
  assert.match(manifest.description, /Marks videos and channels/);
  assert.match(fs.readFileSync('popup/popup.html', 'utf8'), /<html lang="en">/);
  const assets = [manifest.background.service_worker, manifest.action.default_popup,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((script) => [...script.js, ...(script.css || [])])];
  for (const asset of assets) assert.ok(fs.existsSync(asset), `Missing asset: ${asset}`);
});

test('the user configuration template is google-drive.json only', () => {
  const link = JSON.parse(fs.readFileSync('google-drive.json', 'utf8'));
  assert.deepEqual(link, { link: 'PASTE_FILE_LINK_HERE' });
});

test('UI dates, numbers, CSV headers, and download names use English', () => {
  const source = fs.readFileSync('popup/popup.js', 'utf8');
  assert.match(source, /youtube-subscriptions-/);
  assert.match(source, /Channel name/);
  assert.match(source, /en-US/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['.git', 'dist', 'artifacts', 'node_modules', '.venv', '.cache', '__pycache__'].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const isText = (file) => !/\.(?:png|jpg|jpeg|gif|ico|deb|dsc|xz|gz|gpg|asc|pem|key|zip|crx)$/.test(file);

test('project text uses the YOUSUB name and English only', () => {
  for (const file of walk('.')) {
    if (!isText(file) || file === 'tests/english.test.cjs') continue;
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /ytuc|yt-unsub|YT Unsub/i, `Old package name remains in ${file}`);
    assert.doesNotMatch(text, /LEGACY_RESUB|LEGACY_PLACEHOLDERS|legacy-data-compat/, `Legacy compatibility marker remains in ${file}`);
    assert.doesNotMatch(text, /id-ID|localeCompare\([^)]*, 'id'\)/, `Non-English locale remains in ${file}`);
  }
});

test('the project contains no CLI program or native messaging host', () => {
  for (const removed of ['Makefile', 'packaging', 'scripts', 'docs', 'service-account.example.json', 'google-drive.json']) {
    assert.ok(!fs.existsSync(removed), `${removed} must not exist in a browser-extension-only project`);
  }
  for (const file of walk('.')) {
    if (!isText(file) || file === 'tests/english.test.cjs') continue;
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /sendNativeMessage|nativeMessaging|native-messaging-host|cli\.py|config_store|apt-repository/, `CLI reference remains in ${file}`);
  }
  assert.ok(!fs.existsSync('.github/workflows/publish-apt.yml'));
});

test('the Debian package only registers the signed CRX', () => {
  const control = fs.readFileSync('debian/control', 'utf8');
  assert.match(control, /^Package: yousub$/m);
  assert.doesNotMatch(control, /Depends:.*python/);
  const postinst = fs.readFileSync('debian/postinst', 'utf8');
  const postrm = fs.readFileSync('debian/postrm', 'utf8');
  for (const script of [postinst, postrm]) {
    assert.doesNotMatch(script, /python3|openssl|native|cli/);
    assert.match(script, /\/etc\/(?:opt\/chrome|chromium)\/extensions/);
  }
  assert.match(postinst, /yousub-id\.txt/);
  const workflow = fs.readFileSync('.github/workflows/build-extension.yml', 'utf8');
  assert.match(workflow, /dpkg-deb --root-owner-group/);
  assert.match(workflow, /yousub_\${VERSION}_all\.deb/);
  assert.match(workflow, /yousub_\*\.deb/);
});

test('manifest describes the Chrome extension and declares every asset', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'YOUSUB');
  assert.equal(manifest.short_name, 'YOUSUB');
  assert.equal(manifest.version, '2.0.0');
  assert.ok(manifest.minimum_chrome_version);
  assert.ok(!manifest.permissions.includes('nativeMessaging'));
  assert.match(manifest.description, /Marks videos and channels/);
  assert.match(fs.readFileSync('popup/popup.html', 'utf8'), /<html lang="en">/);
  const assets = [manifest.background.service_worker, manifest.action.default_popup,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((script) => [...script.js, ...(script.css || [])])];
  for (const asset of assets) assert.ok(fs.existsSync(asset), `Missing asset: ${asset}`);
});

test('Google Drive settings are edited in the popup, not in configuration files', () => {
  const popup = fs.readFileSync('popup/popup.html', 'utf8');
  assert.doesNotMatch(popup, /id="driveLink"/);
  assert.doesNotMatch(popup, /id="driveKey"/);
  assert.doesNotMatch(popup, /id="driveSaveBtn"/);
  assert.match(popup, /id="driveLinkFile"[^>]*accept="\.json,application\/json"/);
  assert.match(popup, /id="driveKeyFile"[^>]*accept="\.json,application\/json"/);
  const popupJs = fs.readFileSync('popup/popup.js', 'utf8');
  assert.match(popupJs, /Drive\.linkFromConfig/);
  assert.match(popupJs, /YOUSUB\.CONFIG_KEY/);
  assert.match(popupJs, /chrome\.storage\.local\.set/);
  assert.match(fs.readFileSync('shared.js', 'utf8'), /STORE_KEYS:.*yousubDriveConfig/);
});

test('the release workflow signs CRX builds with the repository secret', () => {
  const text = fs.readFileSync('.github/workflows/build-extension.yml', 'utf8');
  assert.match(text, /CRX_PRIVATE_KEY: \$\{\{ secrets\.CRX_PRIVATE_KEY \}\}/);
  assert.match(text, /'dgst', '-sha256', '-sign'/);
  assert.match(text, /manifest\['key'\] = public_key/);
  assert.match(text, /on:\n  workflow_dispatch:/);
  assert.doesNotMatch(text, /echo[^\n]*\$CRX_PRIVATE_KEY/);
});

test('every popup element used by the script exists in the markup', () => {
  const html = fs.readFileSync('popup/popup.html', 'utf8');
  const js = fs.readFileSync('popup/popup.js', 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const [, id] of js.matchAll(/\$\('([^']+)'\)/g)) {
    assert.ok(ids.has(id), `Missing popup element #${id}`);
  }
});

test('UI dates, numbers, CSV headers, and download names use English', () => {
  const source = fs.readFileSync('popup/popup.js', 'utf8');
  assert.match(source, /yousub-subscriptions-/, 'CSV download name must use the new package name');
  assert.match(source, /Channel name/);
  assert.match(source, /en-US/);
});

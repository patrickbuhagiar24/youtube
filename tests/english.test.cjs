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

test('the display name is "Yousub" and internal identifiers stay unchanged', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  assert.equal(manifest.name, 'Yousub');
  assert.equal(manifest.short_name, 'Yousub');
  assert.equal(manifest.action.default_title, 'Yousub');
  const html = fs.readFileSync('popup/popup.html', 'utf8');
  assert.match(html, /<title>Yousub<\/title>/);
  assert.match(html, /<h1>Yousub<\/h1>/);
  // User-facing text only: code identifiers (YOUSUB.*, YOUSUB_CRX_PRIVATE_KEY) and package paths keep their names.
  // Documentation and package descriptions are user-facing prose; code identifiers such as
  // YOUSUB.DRIVE_FILE and YOUSUB_CRX_PRIVATE_KEY keep their original spelling.
  const userFacing = [fs.readFileSync('debian/control', 'utf8'), fs.readFileSync('debian/copyright', 'utf8'),
    fs.readFileSync('README.md', 'utf8')].join('\n');
  assert.doesNotMatch(userFacing, /\bYOUSUB\b/);
  assert.match(fs.readFileSync('shared.js', 'utf8'), /var YOUSUB = Object\.freeze/);
  assert.match(fs.readFileSync('YouTube.json', 'utf8'), /"application": "Yousub"/);
});

test('project text uses the Yousub name and English only', () => {
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
});

test('the Debian package only registers the signed CRX', () => {
  const control = fs.readFileSync('debian/control', 'utf8');
  assert.match(control, /^Package: yousub$/m);
  assert.doesNotMatch(control, /Depends:.*python/);
  const postinst = fs.readFileSync('debian/postinst', 'utf8');
  const postrm = fs.readFileSync('debian/postrm', 'utf8');
  for (const script of [postinst, postrm]) {
    assert.doesNotMatch(script, /python3|openssl|native|cli/);
    assert.match(script, /\/usr\/share\/google-chrome\/extensions/);
    assert.match(script, /\/etc\/chromium\/extensions/);
  }
  assert.match(postinst, /yousub-id\.txt/);
  const workflow = fs.readFileSync('.github/workflows/build-extension.yml', 'utf8');
  assert.match(workflow, /dpkg-deb --root-owner-group/);
  assert.match(workflow, /yousub_\${VERSION}_all\.deb/);
  assert.match(workflow, /yousub_\*\.deb/);
  assert.match(workflow, /usr\/share\/google-chrome\/extensions/);
  assert.match(workflow, /usr\/share\/chromium\/extensions/);
  assert.match(workflow, /yousub-id\.txt/);
});

test('manifest describes the Chrome extension and declares every asset', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'Yousub');
  assert.equal(manifest.short_name, 'Yousub');
  // A plain semantic version; package.test.cjs ties it to the newest changelog entry, so no
  // literal here has to be edited on every release.
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.minimum_chrome_version);
  assert.ok(!manifest.permissions.includes('nativeMessaging'));
  assert.match(manifest.description, /Marks videos and channels/);
  assert.match(fs.readFileSync('popup/popup.html', 'utf8'), /<html lang="en">/);
  const assets = [manifest.background.service_worker, manifest.side_panel.default_path,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((script) => [...script.js, ...(script.css || [])])];
  for (const asset of assets) assert.ok(fs.existsSync(asset), `Missing asset: ${asset}`);
});

test('the side panel removes the saved-configuration button and its wiring', () => {
  const html = fs.readFileSync('popup/popup.html', 'utf8');
  const js = fs.readFileSync('popup/popup.js', 'utf8');
  const background = fs.readFileSync('background.js', 'utf8');
  assert.doesNotMatch(html, /driveClearBtn|Remove saved configuration|🗑️/);
  assert.doesNotMatch(js, /driveClearBtn|driveClear/);
  assert.doesNotMatch(background, /driveClear|clearDriveSettings|config-store\.js/);
  assert.ok(!fs.existsSync('config-store.js'), 'the folder-handle store existed only for that button');
  const build = fs.readFileSync('.github/workflows/build-extension.yml', 'utf8');
  assert.doesNotMatch(build, /config-store\.js/);
});

test('no message asks the user to press F5 or to reload by hand', () => {
  const files = ['content/content.js', 'content/main-world.js', 'popup/popup.js', 'popup/popup.html', 'README.md'];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    // Only what the user can actually see: quoted UI strings, not developer code comments.
    const shown = [...text.matchAll(/'([^'\n]*)'|`([^`]*)`/g)].map((m) => m[1] ?? m[2]).join('\n');
    assert.doesNotMatch(shown, /\bF5\b/, `${file} must not show F5 to the user`);
    assert.doesNotMatch(shown, /reload (the|this) (page|tab)/i, `${file} must not tell the user to reload by hand`);
  }
  // Recovery is automatic instead: a back/forward-cache restore reloads once, and a failed
  // list refresh retries on its own while the stored list stays usable.
  const content = fs.readFileSync('content/content.js', 'utf8');
  assert.match(content, /if \(event\.persisted\) location\.reload\(\)/);
  assert.match(content, /syncRetryTimer = setTimeout\(safe\(\(\) => \{ if \(extAlive && !syncing && subs\.loggedIn !== false\) doSync\(\); \}\), 20000\)/);
  const main = fs.readFileSync('content/main-world.js', 'utf8');
  assert.match(main, /YouTube did not finish loading this page\. Go back to YouTube and try again\./);
});

test('the side panel has no manual refresh or Drive sync buttons', () => {
  const html = fs.readFileSync('popup/popup.html', 'utf8');
  const js = fs.readFileSync('popup/popup.js', 'utf8');
  assert.doesNotMatch(html, /syncBtn|Refresh list|driveSyncBtn|Sync with Google Drive now/);
  assert.doesNotMatch(js, /syncBtn|driveSyncBtn|syncNow/);
  // The list refreshes by itself, so no message tells the user to press a removed button.
  assert.doesNotMatch(js + fs.readFileSync('content/main-world.js', 'utf8'), /click "Refresh list"/i);
  // Drive still exposes the picker (and the automatic sync stays wired in the worker).
  assert.match(html, /id="driveSetupBtn"/);
  assert.match(fs.readFileSync('background.js', 'utf8'), /Drive\.sync\(\)/);
});

test('the Drive row has one configuration button and no form', () => {
  const html = fs.readFileSync('popup/popup.html', 'utf8');
  const js = fs.readFileSync('popup/popup.js', 'utf8');
  const start = html.indexOf('<!-- Unsubscribe history');
  const row = html.slice(start, html.indexOf('</section>', start));
  assert.match(row, /id="unsubCount"/);
  // The button opens the picker itself and names the file it reads.
  assert.match(row, /id="driveSetupBtn"[^>]*>Configuration file…</);
  assert.ok(row.indexOf('driveStatus') < row.indexOf('driveSetupBtn'), 'the button follows the status');
  assert.match(row, /id="setupStatus"/);
  // One button only: there is no sign-out action left, in the panel or in the worker.
  assert.doesNotMatch(html, /signOutBtn|Sign out/);
  assert.doesNotMatch(js + fs.readFileSync('background.js', 'utf8'), /driveSignOut|Drive\.signOut/);
  assert.doesNotMatch(fs.readFileSync('drive.js', 'utf8'), /function signOut/);
  // The collapsible "Configuration file and Google account" box is gone, with its controls.
  for (const id of ['googleSetup', 'chooseFileBtn', 'configInfo']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`), `${id} is gone`);
  }
  assert.doesNotMatch(html, /Configuration file and Google account/);
  assert.doesNotMatch(html, /<details[^>]*setup/);
  assert.doesNotMatch(html + js, /id="driveConfig"|class="mark"|mark\.textContent/);
  // One Drive box only: there is no separate "Google Drive sync" row.
  assert.equal((html.match(/class="card drive"/g) || []).length, 1);
  assert.doesNotMatch(html, /<div>Google Drive sync<\/div>/);
  assert.doesNotMatch(html, /id="clientId"|id="clientSecret"|id="driveLink"|id="saveSetupBtn"|id="redirectUri"/);
  assert.match(js, /showOpenFilePicker/);
  assert.match(js, /YousubConfigFile\.read/);
  assert.match(js, /type: 'driveSync', signIn: true/);
  assert.match(js, /setup\.classList\.toggle\('configured', configured\)/);
});

test('every message points at a control the panel really has', () => {
  const drive = fs.readFileSync('drive.js', 'utf8');
  const html = fs.readFileSync('popup/popup.html', 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  // The panel has no "Sign in" button and no "Client secret" field any more: the secret lives in
  // the configuration file. A message that names them sends the reader looking for nothing.
  assert.doesNotMatch(drive, /click Sign in\./);
  assert.doesNotMatch(drive, /"Client secret" field/);
  assert.doesNotMatch(drive, /Click ⚙️/);
  // The one control that does exist.
  assert.ok(ids.has('driveSetupBtn'), 'the Configuration file… button opens the picker');
  assert.match(drive, /const OPEN_FORM = 'Open the side panel and click "Configuration file…"\.'/);
  assert.match(drive, /const SIGN_IN = 'Open the side panel, click "Configuration file…", and pick the file again to sign in\.'/);
  // The consent screen for auth/drive does not read like the narrow drive.file one.
  assert.doesNotMatch(drive, /See, edit, create and delete only the specific Google Drive files/);
  assert.match(drive, /only touches the one file named in the configuration/);
});

test('the sign-in record is a stored key, so an update cannot delete it', () => {
  const shared = fs.readFileSync('shared.js', 'utf8');
  const keys = JSON.parse(shared.match(/STORE_KEYS: Object\.freeze\((\[[^\]]*\])\)/)[1].replace(/'/g, '"'));
  // onInstalled runs on every extension update and deletes local keys missing from this list;
  // dropping the token key silently stops the background sync until the person signs in again.
  assert.ok(keys.includes('yousubOAuthTokens'), 'the refresh token survives an update');
  for (const key of ['yousubSubs', 'yousubUnsubs', 'yousubDrive', 'yousubDriveConfig']) assert.ok(keys.includes(key), key);
  assert.match(fs.readFileSync('background.js', 'utf8'), /await Drive\.restoreSignIn\(\)/);
  // The flow record and its mirror live in chrome.storage.session, which the onInstalled sweep
  // never touches because it only reads chrome.storage.local.
  assert.doesNotMatch(shared, /yousubOAuthFlow/);
});

test('the panel redraws from one storage listener, not three', () => {
  const js = fs.readFileSync('popup/popup.js', 'utf8');
  assert.equal((js.match(/chrome\.storage\.onChanged\.addListener/g) || []).length, 1);
  assert.doesNotMatch(js, /EMAIL_KEY/, 'the sign-in record is not an email key');
  assert.match(js, /const TOKENS_KEY = 'yousubOAuthTokens';/);
});

test('the manifest asks only for the hosts the code contacts', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  assert.deepEqual(manifest.host_permissions, [
    'https://www.youtube.com/*',
    'https://oauth2.googleapis.com/*',
    'https://www.googleapis.com/*'
  ]);
  // A Drive file link is a value in the configuration, never a page the extension requests.
  for (const gone of ['https://drive.google.com/*', 'https://*.googleusercontent.com/*']) {
    assert.ok(!manifest.host_permissions.includes(gone), `${gone} is not contacted`);
  }
});

test('configuration is one cached file, not a folder scan', () => {
  const html = fs.readFileSync('popup/popup.html', 'utf8');
  const js = fs.readFileSync('popup/popup.js', 'utf8');
  // No folder picker and no folder scanner remain anywhere in the extension.
  assert.doesNotMatch(html + js, /showDirectoryPicker|YousubFolder|folder-config/);
  assert.equal(fs.existsSync('folder-config.js'), false);
  assert.ok(fs.existsSync('config-file.js'), 'the file loader exists');
  const build = fs.readFileSync('.github/workflows/build-extension.yml', 'utf8');
  assert.match(build, /config-file\.js/);
  assert.doesNotMatch(build, /folder-config\.js/);
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(ci, /config-file\.js/);
  // The file format has its own guard.
  const loader = fs.readFileSync('config-file.js', 'utf8');
  for (const key of ['yousub-file', 'client_id', 'client_secret']) assert.match(loader, new RegExp(`'${key.replace('_', '_')}'`));
  assert.match(loader, /version: VERSION/);
});

test('the APT repository workflow is signed and deployed through Pages', () => {
  const text = fs.readFileSync('.github/workflows/publish-apt.yml', 'utf8');
  assert.match(text, /GPG_PRIVATE_KEY: \$\{\{ secrets\.GPG_PRIVATE_KEY \}\}/);
  assert.match(text, /GPG_PASSPHRASE: \$\{\{ secrets\.GPG_PASSPHRASE \}\}/);
  assert.match(text, /Suites: stable/);
  // One suite only: "stonking" was an alias and is gone.
  assert.match(text, /for suite in \('stable',\):/);
  assert.match(text, /for suite in stable; do/);
  assert.doesNotMatch(text, /stonking/);
  assert.match(text, /Signed-By: \/etc\/apt\/keyrings\/yousub\.gpg/);
  assert.match(text, /actions\/deploy-pages/);
  assert.match(text, /gpgv --keyring/);
  assert.doesNotMatch(text, /Trusted: yes/);
  const readme = fs.readFileSync('README.md', 'utf8');
  assert.match(readme, /^## Install from the APT repository$/m);
  assert.match(readme, /patrickbuhagiar24\.github\.io\/youtube\/yousub\.sources/);
  assert.doesNotMatch(readme, /github\.com\/patrickbuhagiar24\/youtube\/releases/);
  assert.match(text, /gh run download/);
  assert.match(text, /sha256sum -c checksums\.txt/);
  assert.doesNotMatch(text, /gh release/);
});

test('releases are Pages-only: no release tags and no GitHub Releases', () => {
  const publish = fs.readFileSync('.github/workflows/publish-apt.yml', 'utf8');
  const build = fs.readFileSync('.github/workflows/build-extension.yml', 'utf8');
  for (const text of [publish, build]) {
    assert.doesNotMatch(text, /tags: \['v\*'\]/, 'no workflow may trigger on version tags');
    assert.doesNotMatch(text, /github\.ref_name|head_branch == \\?"\$TAG/, 'no workflow may resolve a tag');
    assert.doesNotMatch(text, /gh release|softprops\/action-gh-release|actions\/create-release/, 'no GitHub Releases');
  }
  // Merging to main publishes; a manual run can target any branch (verified: Pages accepts it).
  assert.match(publish, /on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:/);
  // The version comes from manifest.json, and an unchanged version is not redeployed.
  assert.doesNotMatch(publish, /github\.ref == 'refs\/heads\/main'/);
  assert.match(publish, /uses: \.\/\.github\/workflows\/build-extension\.yml/);
  // Without this the called workflow cannot see YOUSUB_CRX_PRIVATE_KEY / GPG secrets.
  assert.match(publish, /secrets: inherit/);
  assert.match(publish, /needs: build/);
  assert.match(publish, /already/);
  assert.match(build, /on:\n {2}workflow_call:\n {2}workflow_dispatch:/);
  // The publish job receives its artifact from the build job of the same run, falling back to
  // this run's id when the reusable workflow does not expose its own.
  assert.match(publish, /run_id="\$\{\{ needs\.build\.outputs\.run_id \|\| github\.run_id \}\}"/);
  assert.match(publish, /gh run download "\$run_id"/);
});

test('the build workflow signs the CRX and does not publish a GitHub Release', () => {
  const text = fs.readFileSync('.github/workflows/build-extension.yml', 'utf8');
  assert.match(text, /YOUSUB_CRX_PRIVATE_KEY: \$\{\{ secrets\.YOUSUB_CRX_PRIVATE_KEY \}\}/);
  assert.match(text, /'dgst', '-sha256', '-sign'/);
  assert.match(text, /manifest\['key'\] = public_key/);
  assert.match(text, /on:\n {2}workflow_call:\n {2}workflow_dispatch:/);
  assert.doesNotMatch(text, /echo[^\n]*\$YOUSUB_CRX_PRIVATE_KEY/);
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

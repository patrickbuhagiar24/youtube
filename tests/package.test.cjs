// Guards the Debian package and archive metadata: one source of truth for the version,
// Section/Priority filed by the archive, Installed-Size present, and the suite name used by
// both the changelog and the repository.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const read = (path) => fs.readFileSync(path, 'utf8');

test('one source of truth per control field', () => {
  const control = read('debian/control');
  assert.match(control, /^Source: yousub$/m);
  assert.match(control, /^Section: web$/m); // Official Debian section for browser add-ons
  assert.match(control, /^Priority: optional$/m); // Default for non-essential packages
  assert.match(control, /^Package: yousub$/m);
  assert.match(control, /^Architecture: all$/m);
  // The version lives in manifest.json / debian/changelog only, never in debian/control.
  assert.doesNotMatch(control, /^Version:/m);
  assert.ok(fs.existsSync('debian/source/format'), 'a native source format is declared');
  assert.equal(read('debian/source/format').trim(), '3.0 (native)');
  const build = read('.github/workflows/build-extension.yml');
  // dpkg-gencontrol derives Version, Installed-Size, Section, Priority and Description-md5.
  assert.match(build, /dpkg-gencontrol -v"\$VERSION" -pyousub -P"\$deb" -O > "\$deb\/DEBIAN\/control"/);
  assert.match(build, /grep -qx "Version: \$VERSION"/);
  assert.match(build, /grep -q "\^Installed-Size: "/);
  // Policy 12.5: the package must install /usr/share/doc/yousub/copyright, and lintian reports a
  // missing one as an error, which fails the publish job.
  assert.match(build, /install -m 0644 debian\/copyright "\$deb\/usr\/share\/doc\/yousub\/copyright"/);
  assert.ok(fs.existsSync('debian/copyright'), 'the copyright file exists');
  // No hand-rolled replacements of generated fields.
  assert.doesNotMatch(build, /sed -i "s\/\^Version:/);
  assert.doesNotMatch(build, /installed_size=/);
});

test('the source stanza declares Standards-Version and Rules-Requires-Root', () => {
  const control = read('debian/control');
  // Both fields belong to the source stanza: everything before the empty line that starts the
  // binary stanza. In the binary stanza they would still be parsed, but they would be wrong.
  const [source, binary] = control.split(/\n\s*\n/);
  assert.ok(binary, 'control holds a source and a binary stanza');
  // Policy 5.6.11: the first three components matter, the fourth is cosmetic; 4.7.4.1 is the
  // policy version this package was reviewed against.
  assert.match(source, /^Standards-Version: \d+\.\d+\.\d+(\.\d+)?$/m);
  // Policy 5.6.31: the build needs neither root nor fakeroot (the maintainer scripts run at
  // install time, which this field does not describe).
  assert.match(source, /^Rules-Requires-Root: no$/m);
  assert.doesNotMatch(binary, /Standards-Version|Rules-Requires-Root/, 'the fields stay out of the binary stanza');
});

test('the package passes the lint rules the publish job enforces', () => {
  const build = read('.github/workflows/build-extension.yml');
  const control = read('debian/control');
  const changelog = read('debian/changelog');
  // dir-or-file-in-etc-opt: /etc/opt is reserved for add-on software.
  assert.doesNotMatch(build, /etc\/opt\//, 'no file is installed under /etc/opt');
  for (const script of [read('debian/postinst'), read('debian/postrm')]) {
    assert.doesNotMatch(script, /\/etc\/opt\//, 'the maintainer scripts do not create it either');
  }
  // file-in-etc-not-marked-as-conffile: the registration in /etc is a configuration file.
  assert.match(build, /printf '\/etc\/chromium\/extensions\/%s\.json\\n' "\$EXTENSION_ID" > "\$deb\/DEBIAN\/conffiles"/);
  // file-missing-in-md5sums: every installed file is listed, DEBIAN excluded.
  assert.match(build, /find \. -path \.\/DEBIAN -prune -o -type f -print0/);
  // extra-license-file: MIT in full lives in debian/copyright, so no second LICENSE in /usr/share/doc.
  assert.doesNotMatch(build, /cp README\.md LICENSE/);
  // description-starts-with-package-name: the synopsis must not begin with "Yousub".
  assert.doesNotMatch(control, /^Description: Yousub\b/m);
  assert.match(control, /^Description: YouTube subscription marker for Chrome$/m);
  // latest-changelog-entry-without-new-date: the newest entry is dated after the one below it.
  const dates = [...changelog.matchAll(/^ -- .*? {2}(.+)$/gm)].map((m) => Date.parse(m[1]));
  assert.ok(dates.length >= 10);
  assert.ok(dates[0] > dates[1], 'the newest changelog entry has its own, newer date');
  for (let i = 1; i < dates.length; i += 1) assert.ok(dates[i] <= dates[i - 1], 'entries stay in order');
});

test('the archive is filed by the package and adds no override file', () => {
  assert.equal(fs.existsSync('debian/control.override'), false, 'Section/Priority come from the package');
  const publish = read('.github/workflows/publish-apt.yml');
  assert.match(publish, /dpkg-scanpackages --arch all pool \/dev\/null/);
});

test('the archive can be fetched by hash and expires its indices', () => {
  const publish = read('.github/workflows/publish-apt.yml');
  assert.match(publish, /'Acquire-By-Hash: yes'/);
  assert.match(publish, /'Valid-Until: ' \+ format_datetime/);
  // Every published index is copied under by-hash/<ALGO>/<digest> for SHA256 and SHA512.
  assert.match(publish, /root \/ 'by-hash' \/ algorithm\.upper\(\)/);
  assert.match(publish, /if algorithm in \('sha256', 'sha512'\)/);
  // One suite only.
  assert.doesNotMatch(read('README.md') + publish, /stonking/);
  assert.match(publish, /for suite in \('stable',\):/);
  assert.match(publish, /lintian --fail-on error/);
});

test('the deploy job targets the github-pages environment', () => {
  const publish = read('.github/workflows/publish-apt.yml');
  // actions/deploy-pages resolves its artifact through the environment; without this block the
  // deploy step fails with "No artifacts named github-pages were found for this workflow run"
  // even though the upload step succeeded.
  assert.match(publish, /environment:\n {6}name: github-pages\n {6}url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}\n/);
  assert.match(publish, /id: deployment/);
  assert.match(publish, /pages: write/);
  assert.match(publish, /id-token: write/);
});

test('CI lints the built package and fails on errors', () => {
  const publish = read('.github/workflows/publish-apt.yml');
  assert.match(publish, /dpkg-dev gnupg gpgv/);
  assert.match(publish, /lintian --fail-on error/);
});

test('CI runs the side-panel tests in the same Node version', () => {
  const ci = read('.github/workflows/ci.yml');
  // The panel tests need jsdom; without an install step they would be skipped, not failed.
  assert.match(ci, /container: node:22\n/);
  assert.match(ci, /npm ci --no-audit --no-fund/);
  assert.match(ci, /node --test tests\/\*\.test\.cjs/);
  const pkg = JSON.parse(read('package.json'));
  // js-yaml is only here because a workflow file was validated by hand; it must never be a
  // declared dependency (npm install <pkg> writes one unless --no-save is used).
  assert.equal(pkg.dependencies, undefined, 'no runtime dependency slipped into package.json');
  assert.equal(pkg.private, true, 'the package is never published');
  assert.ok(pkg.devDependencies.jsdom, 'jsdom is a development dependency');
  assert.equal(pkg.dependencies, undefined, 'the extension itself has no runtime dependencies');
  assert.ok(fs.existsSync('package-lock.json'), 'npm ci needs a lock file');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.packages['node_modules/jsdom'].version, pkg.devDependencies.jsdom);
  // jsdom is test-only: it must never be shipped in the CRX or the ZIP.
  const build = read('.github/workflows/build-extension.yml');
  assert.doesNotMatch(build, /node_modules|package\.json/);
});

test('the changelog suite matches the published suite', () => {
  const changelog = read('debian/changelog');
  const versions = [...changelog.matchAll(/^yousub \(([^)]+)\) (\S+); urgency=(\S+)$/gm)];
  assert.ok(versions.length >= 10, 'the whole history is kept');
  const [, version, suite] = versions[0];
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(version, manifest.version, 'the newest changelog entry is the shipped version');
  assert.equal(suite, 'stable');
  for (const [, , entrySuite] of versions) assert.equal(entrySuite, 'stable', 'no entry uses an unpublished suite');
  const publish = read('.github/workflows/publish-apt.yml');
  assert.match(publish, /Suites: stable/);
  assert.doesNotMatch(publish, /stonking/);
});

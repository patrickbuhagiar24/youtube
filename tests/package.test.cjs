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
  // No hand-rolled replacements of generated fields.
  assert.doesNotMatch(build, /sed -i "s\/\^Version:/);
  assert.doesNotMatch(build, /installed_size=/);
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

test('CI lints the built package and fails on errors', () => {
  const publish = read('.github/workflows/publish-apt.yml');
  assert.match(publish, /dpkg-dev gnupg gpgv/);
  assert.match(publish, /lintian --fail-on error/);
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

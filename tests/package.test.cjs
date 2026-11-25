// Guards the Debian package and archive metadata: one source of truth for the version,
// Section/Priority filed by the archive, Installed-Size present, and the suite name used by
// both the changelog and the repository.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const read = (path) => fs.readFileSync(path, 'utf8');

test('the package version comes from the manifest only', () => {
  const control = read('debian/control');
  assert.match(control, /^Package: yousub$/m);
  assert.match(control, /^Architecture: all$/m);
  // No Version, Section or Priority in the built control: they are filled in at build time
  // (version from manifest.json) or by the archive override (section and priority).
  assert.doesNotMatch(control, /^Version:/m);
  assert.doesNotMatch(control, /^Section:/m);
  assert.doesNotMatch(control, /^Priority:/m);
  const build = read('.github/workflows/build-extension.yml');
  assert.match(build, /sed -i "s\/\^Version: \.\*\/Version: \$VERSION\/"/);
  // Installed-Size is computed per file the way dpkg counts it.
  assert.match(build, /installed_size=\$\(cd "\$deb" && find usr -type f -printf '%s\\n'/);
  assert.match(build, /Installed-Size: \$installed_size/);
});

test('the archive files the package through an override file', () => {
  const override = read('debian/control.override');
  const line = override.split('\n').find((row) => row.startsWith('yousub'));
  assert.ok(line, 'yousub is listed in the override file');
  // dpkg-scanpackages reads "package priority section" (not "package section priority").
  assert.deepEqual(line.trim().split(/\s+/), ['yousub', 'optional', 'web']);
  const publish = read('.github/workflows/publish-apt.yml');
  assert.match(publish, /dpkg-scanpackages --arch all pool control\.override/);
  assert.doesNotMatch(publish, /dpkg-scanpackages --arch all pool \/dev\/null > dists/);
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
  assert.match(publish, /for suite in \('stable', 'stonking'\)/);
});

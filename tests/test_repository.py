import gzip
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location('release', ROOT / 'scripts' / 'write-apt-release.py')
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class RepositoryTests(unittest.TestCase):
    def test_release_checksums_cover_plain_and_gzip_indices(self):
        with tempfile.TemporaryDirectory() as temp:
            dist = Path(temp)
            index = dist / 'main' / 'binary-all' / 'Packages'
            index.parent.mkdir(parents=True)
            data = b'Package: yt-unsub-detector\nArchitecture: all\n'
            index.write_bytes(data)
            (index.parent / 'Packages.gz').write_bytes(gzip.compress(data, mtime=0))
            release.write_release(dist, 'stonking')
            text = (dist / 'Release').read_text()
            self.assertIn('Codename: stonking', text)
            self.assertIn('Architectures: all', text)
            self.assertIn('Components: main', text)
            self.assertIn(hashlib.sha256(data).hexdigest(), text)
            self.assertIn('main/binary-all/Packages.gz', text)
            self.assertNotIn('InRelease', text)

    def test_empty_archive_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError, 'without package indices'):
                release.write_release(Path(temp), 'stonking')

    def test_client_source_is_scoped_and_signature_verified(self):
        text = (ROOT / 'packaging' / 'yt-unsub-detector.sources').read_text()
        self.assertIn('Suites: stonking', text)
        self.assertIn('Architectures: all', text)
        self.assertIn('Signed-By: /etc/apt/keyrings/yt-unsub-detector.gpg', text)
        self.assertNotIn('Trusted: yes', text)

    def test_publish_workflow_uses_repository_gpg_secrets_without_exposing_them(self):
        text = (ROOT / '.github' / 'workflows' / 'publish-apt.yml').read_text()
        self.assertIn('GPG_PRIVATE_KEY: ${{ secrets.GPG_PRIVATE_KEY }}', text)
        self.assertIn('GPG_PASSPHRASE: ${{ secrets.GPG_PASSPHRASE }}', text)
        self.assertIn("printf '%s' \"$GPG_PRIVATE_KEY\" | gpg --batch --import", text)
        self.assertIn('APT_SIGNING_KEY_ID=%s', text)
        self.assertIn('rm -rf "$GNUPGHOME"', text)
        self.assertNotIn('secrets.APT_SIGNING_', text)
        self.assertNotIn('echo "$GPG_PRIVATE_KEY"', text)
        self.assertNotIn('echo "$GPG_PASSPHRASE"', text)


if __name__ == '__main__':
    unittest.main()

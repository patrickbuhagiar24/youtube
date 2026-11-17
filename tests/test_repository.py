import gzip
import hashlib
import html
import importlib.util
import os
from pathlib import Path
import subprocess
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

    def test_install_instructions_are_consistent_and_fail_closed(self):
        readme = (ROOT / 'README.md').read_text()
        section = readme.split('Obtain the **full 40-character', 1)[1]
        script = section.split('```bash\n', 1)[1].split('\n```', 1)[0]
        page = (ROOT / 'packaging' / 'apt-index.html').read_text()
        self.assertEqual(script, html.unescape(page.split('<pre>', 1)[1].split('</pre>', 1)[0]))
        source = (ROOT / 'packaging' / 'yt-unsub-detector.sources').read_text().strip()
        self.assertIn(source, script)
        self.assertNotIn('sudo tee', script)
        subprocess.run(['bash', '-n'], input=script, text=True, check=True)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            bindir = root / 'bin'
            bindir.mkdir()
            scratch = root / 'scratch'
            scratch.mkdir()
            log = root / 'sudo.log'
            stubs = {
                'curl': '#!/bin/sh\n[ "${CURL_FAIL:-0}" = 0 ] || exit 22\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; printf key > "$1"; break; fi; shift; done\n',
                'gpg': '#!/bin/sh\n[ "${GPG_FAIL:-0}" = 0 ] || exit 2\nprintf "%s\\n" "$GPG_OUTPUT"\n',
                'sudo': '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SUDO_LOG"\n',
            }
            for name, contents in stubs.items():
                path = bindir / name
                path.write_text(contents)
                path.chmod(0o755)
            fingerprint = 'A' * 40
            env = dict(os.environ, PATH=f'{bindir}:{os.environ["PATH"]}', TMPDIR=str(scratch),
                       SUDO_LOG=str(log), GPG_OUTPUT=f'pub:::::::::\nfpr:::::::::{fingerprint}:')

            # Feed input separately from the shell's program, as in an interactive terminal.
            def execute(expected, **overrides):
                log.unlink(missing_ok=True)
                result = subprocess.run(['bash', '-c', script], input=expected + '\n', text=True,
                                        capture_output=True, env={**env, **overrides})
                self.assertEqual(list(scratch.iterdir()), [], 'temporary directory must be removed')
                return result

            self.assertEqual(execute(fingerprint.lower()).returncode, 0)
            commands = log.read_text()
            self.assertIn('install -m 0644', commands)
            self.assertIn('apt update', commands)
            self.assertIn('apt install yt-unsub-detector', commands)
            for expected, overrides in (
                ('B' * 40, {}),
                (fingerprint, {'CURL_FAIL': '1'}),
                (fingerprint, {'GPG_FAIL': '1'}),
                (fingerprint, {'GPG_OUTPUT': env['GPG_OUTPUT'] + '\npub:::::::::\nfpr:::::::::' + 'B' * 40 + ':'}),
            ):
                self.assertNotEqual(execute(expected, **overrides).returncode, 0)
                self.assertFalse(log.exists(), 'failed verification must not run sudo')

    def test_publish_workflow_runs_on_main_and_manual_dispatch(self):
        text = (ROOT / '.github' / 'workflows' / 'publish-apt.yml').read_text()
        self.assertIn('on:\n  push:\n    branches: [main]\n  workflow_dispatch:', text)
        self.assertNotIn("tags: ['v*']", text)

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
        # GitHub rejects runner.temp in job-level env; keep it on the steps.
        self.assertNotIn('    env:\n      GNUPGHOME: ${{ runner.temp }}', text)
        self.assertEqual(text.count('          GNUPGHOME: ${{ runner.temp }}/ytuc-apt-gnupg'), 3)


if __name__ == '__main__':
    unittest.main()

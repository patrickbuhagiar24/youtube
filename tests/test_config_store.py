import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


config_store = load('config_store', 'packaging/config_store.py')


class ConfigStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.old_env = {key: os.environ.get(key) for key in ('HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME')}
        os.environ['HOME'] = str(self.root)
        os.environ['XDG_CONFIG_HOME'] = str(self.root / '.config')
        os.environ.pop('XDG_DATA_HOME', None)

    def tearDown(self):
        for key, value in self.old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_first_use_creates_only_two_private_user_files(self):
        path = config_store.ensure_config()
        directory = path.parent
        self.assertEqual(path, self.root / '.config' / 'yt-unsub-detector' / 'google-drive.json')
        self.assertEqual(sorted(item.name for item in directory.iterdir()), ['google-drive.json', 'service-account.json'])
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual(json.loads(path.read_text()), {'link': 'PASTE_FILE_LINK_HERE'})
        self.assertEqual((directory / 'service-account.json').read_text().strip(), '{}')
        result = config_store.read_config()
        self.assertTrue(result['ok'])
        self.assertFalse(result['configured'])
        self.assertIsNone(result['key'])
        self.assertEqual(result['link'], '')
        self.assertEqual(result['configPath'], str(path))
        self.assertEqual(result['keyPath'], str(directory / 'service-account.json'))

    def test_link_object_and_json_string_are_supported(self):
        path = config_store.ensure_config()
        link = 'https://drive.google.com/file/d/abcdefghij1234567890/view'
        path.write_text(json.dumps({'link': link}))
        result = config_store.read_config()
        self.assertTrue(result['configured'])
        self.assertEqual(result['link'], link)
        path.write_text(json.dumps(link))
        result = config_store.read_config()
        self.assertTrue(result['configured'])
        self.assertEqual(result['link'], link)

    def test_key_is_read_only_from_service_account_json(self):
        path = config_store.ensure_config()
        link = 'https://drive.google.com/file/d/abcdefghij1234567890/view'
        path.write_text(json.dumps({'link': link, 'serviceAccount': 'ignored.json'}))
        key = {'type': 'service_account', 'client_email': 'test@example.invalid', 'private_key': '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----'}
        (path.parent / 'service-account.json').write_text(json.dumps(key))
        (path.parent / 'ignored.json').write_text('{"type":"service_account"}')
        result = config_store.read_config()
        self.assertEqual(result['key'], key)
        self.assertEqual(result['keyPath'], str(path.parent / 'service-account.json'))

    def test_invalid_config_reports_english_error_without_private_contents(self):
        path = config_store.ensure_config()
        path.write_text('{broken')
        result = config_store.read_config()
        self.assertFalse(result['ok'])
        self.assertIn(str(path), result['error'])
        path.write_text('[]')
        result = config_store.read_config()
        self.assertFalse(result['ok'])
        self.assertIn('JSON object or a JSON string', result['error'])
        path.write_text('{"link":"PASTE_FILE_LINK_HERE"}')
        (path.parent / 'service-account.json').write_text('{broken')
        result = config_store.read_config()
        self.assertFalse(result['ok'])
        self.assertIn('valid JSON key file', result['error'])
        self.assertNotIn('PRIVATE', result['error'])

    def test_placeholder_and_deleted_config_stay_disabled(self):
        path = config_store.ensure_config()
        path.unlink()
        result = config_store.read_config()
        self.assertTrue(result['ok'])
        self.assertFalse(result['configured'])
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(path.read_text()), {'link': 'PASTE_FILE_LINK_HERE'})

    def test_symlink_configuration_directory_is_rejected(self):
        target = self.root / 'target'
        target.mkdir()
        (self.root / '.config').mkdir()
        (self.root / '.config' / 'yt-unsub-detector').symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            config_store.ensure_config()

    def test_old_wrapper_is_migrated_and_removed(self):
        directory = self.root / '.config' / 'yt-unsub-detector'
        directory.mkdir(parents=True)
        link = 'https://drive.google.com/file/d/abcdefghij1234567890/view'
        key = {'type': 'service_account', 'client_email': 'test@example.invalid', 'private_key': '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----'}
        (directory / 'drive-config.json').write_text(json.dumps({'link': link, 'serviceAccount': 'key.json'}))
        (directory / 'key.json').write_text(json.dumps(key))
        path = config_store.ensure_config()
        self.assertEqual(sorted(item.name for item in directory.iterdir()), ['google-drive.json', 'service-account.json'])
        self.assertEqual(json.loads(path.read_text())['link'], link)
        self.assertEqual(json.loads((directory / 'service-account.json').read_text()), key)
        self.assertEqual((directory / 'service-account.json').stat().st_mode & 0o777, 0o600)
        self.assertTrue(config_store.read_config()['configured'])

    def test_old_wrapper_pointing_at_google_drive_is_removed_without_overwriting(self):
        directory = self.root / '.config' / 'yt-unsub-detector'
        directory.mkdir(parents=True)
        (directory / 'drive-config.json').write_text('{"link":"google-drive.json","serviceAccount":"service-account.json"}')
        (directory / 'google-drive.json').write_text('{"link":"abcdefghij1234567890"}')
        path = config_store.ensure_config()
        self.assertFalse((directory / 'drive-config.json').exists())
        self.assertEqual(json.loads(path.read_text())['link'], 'abcdefghij1234567890')
        path.write_text('{"link":"new"}')
        config_store.ensure_config()
        self.assertEqual(path.read_text(), '{"link":"new"}')

    def test_legacy_per_user_extension_config_is_migrated_once(self):
        legacy = self.root / '.local' / 'share' / 'yt-unsub-detector' / 'extension'
        legacy.mkdir(parents=True)
        (legacy / 'drive-config.json').write_text('{"link":"google-drive.json"}')
        (legacy / 'google-drive.json').write_text('{"link":"abcdefghij1234567890"}')
        (legacy / 'service-account.json').write_text('{"type":"service_account"}')
        path = config_store.ensure_config()
        self.assertEqual(sorted(item.name for item in path.parent.iterdir()), ['google-drive.json', 'service-account.json'])
        self.assertEqual(json.loads(path.read_text())['link'], 'abcdefghij1234567890')
        self.assertEqual((path.parent / 'service-account.json').stat().st_mode & 0o777, 0o600)
        path.write_text('{"link":"new"}')
        config_store.ensure_config()
        self.assertEqual(path.read_text(), '{"link":"new"}')

    def load_cli(self):
        packaging = str(ROOT / 'packaging')
        sys.path.insert(0, packaging)
        self.addCleanup(sys.path.remove, packaging)
        return load('cli', 'packaging/cli.py')

    def test_cli_prints_two_paths_and_status(self):
        # The CI container runs as root. Test the desktop-user path in process;
        # the workflow separately runs the installed CLI through runuser.
        cli = self.load_cli()
        stdout = io.StringIO()
        with mock.patch.object(cli.os, 'geteuid', return_value=1000), contextlib.redirect_stdout(stdout):
            self.assertEqual(cli.main(['config']), 0)
        text = stdout.getvalue()
        self.assertIn('Google Drive configuration:', text)
        self.assertIn('google-drive.json', text)
        self.assertIn('service-account.json', text)
        self.assertNotIn('drive-config.json', text)

        stdout = io.StringIO()
        with mock.patch.object(cli.os, 'geteuid', return_value=1000), contextlib.redirect_stdout(stdout):
            self.assertEqual(cli.main(['status']), 0)
        text = stdout.getvalue()
        self.assertIn('Configuration file:', text)
        self.assertIn('Drive link configured: no', text)
        self.assertNotIn('drive-config.json', text)

    def test_cli_refuses_root(self):
        cli = self.load_cli()
        stderr = io.StringIO()
        with mock.patch.object(cli.os, 'geteuid', return_value=0), contextlib.redirect_stderr(stderr):
            self.assertEqual(cli.main(['config']), 1)
        self.assertIn('without sudo', stderr.getvalue())
        self.assertFalse((self.root / '.config').exists())


class BrowserSetupTests(unittest.TestCase):
    def setUp(self):
        self.browser_setup = load('browser_setup', 'packaging/browser_setup.py')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'extension'
        self.source.mkdir()
        (self.source / 'manifest.json').write_text(json.dumps({'manifest_version': 3, 'name': 'Test', 'version': '1.21.0'}))
        (self.source / 'background.js').write_text('// test')
        (self.source / 'drive-config.json').write_text('CONFIG')
        (self.source / 'google-drive.json').write_text('LINK')
        (self.source / 'service-account.json').write_text('PRIVATE')
        self.key = self.root / 'key.pem'
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', str(self.key)], check=True, capture_output=True)

    def test_repairs_only_private_owned_shared_directories(self):
        private = self.root / 'private'
        private.mkdir(mode=0o700)
        already_public = self.root / 'public'
        already_public.mkdir(mode=0o750)
        link = self.root / 'link'
        link.symlink_to(private, target_is_directory=True)
        nested = private / 'nested'
        nested.mkdir(mode=0o700)
        self.browser_setup.repair_private_shared_dirs(
            (link, link / 'nested', private, already_public, self.root / 'missing'), owner=os.geteuid()
        )
        self.assertEqual(private.stat().st_mode & 0o777, 0o755)
        self.assertEqual(nested.stat().st_mode & 0o777, 0o700)
        self.assertEqual(already_public.stat().st_mode & 0o777, 0o750)

    def test_crx3_signature_id_and_registration(self):
        crx = self.root / 'test.crx'
        extension_id, version = self.browser_setup.build_crx(self.source, self.key, crx)
        self.assertEqual(version, '1.21.0')
        self.assertRegex(extension_id, r'^[a-p]{32}$')
        data = crx.read_bytes()
        self.assertEqual(data[:4], b'Cr24')
        header_length = struct.unpack('<I', data[8:12])[0]
        header = data[12:12 + header_length]
        archive = data[12 + header_length:]
        self.assertTrue(archive.startswith(b'PK'))
        self.assertNotIn(b'PRIVATE', archive)
        self.assertNotIn(b'CONFIG', archive)
        self.assertNotIn(b'LINK', archive)

        def fields(blob):
            out = {}
            offset = 0
            while offset < len(blob):
                tag = 0
                shift = 0
                while True:
                    byte = blob[offset]
                    offset += 1
                    tag |= (byte & 0x7F) << shift
                    if not byte & 0x80:
                        break
                    shift += 7
                number, wire = tag >> 3, tag & 7
                self.assertEqual(wire, 2)
                length = 0
                shift = 0
                while True:
                    byte = blob[offset]
                    offset += 1
                    length |= (byte & 0x7F) << shift
                    if not byte & 0x80:
                        break
                    shift += 7
                out.setdefault(number, []).append(blob[offset:offset + length])
                offset += length
            return out

        parsed = fields(header)
        proof = fields(parsed[2][0])
        public = proof[1][0]
        signature = proof[2][0]
        signed_data = parsed[10000][0]
        self.assertEqual(fields(signed_data)[1][0], bytes.fromhex(''.join(f'{ord(c) - ord("a"):x}' for c in extension_id)))
        payload = b'CRX3 SignedData\x00' + struct.pack('<I', len(signed_data)) + signed_data + archive
        payload_path = self.root / 'payload.bin'
        signature_path = self.root / 'signature.bin'
        public_path = self.root / 'public.der'
        payload_path.write_bytes(payload)
        signature_path.write_bytes(signature)
        public_path.write_bytes(public)
        pem = subprocess.run(['openssl', 'pkey', '-pubin', '-inform', 'DER', '-in', str(public_path), '-outform', 'PEM'], check=True, capture_output=True).stdout
        pem_path = self.root / 'public.pem'
        pem_path.write_bytes(pem)
        subprocess.run(['openssl', 'dgst', '-sha256', '-verify', str(pem_path), '-signature', str(signature_path), str(payload_path)], check=True, capture_output=True)

        external = self.root / 'external'
        native = self.root / 'native'
        self.browser_setup.register(extension_id, version, crx, (external,), (native,))
        pref = json.loads((external / f'{extension_id}.json').read_text())
        self.assertEqual(pref, {'external_crx': str(crx), 'external_version': version})
        host = json.loads((native / f'{self.browser_setup.HOST_NAME}.json').read_text())
        self.assertEqual(host['allowed_origins'], [f'chrome-extension://{extension_id}/'])
        self.assertEqual(host['path'], self.browser_setup.HOST_BINARY)


class NativeHostTests(unittest.TestCase):
    def test_native_message_protocol_reads_user_config(self):
        with tempfile.TemporaryDirectory() as temp:
            env = dict(os.environ, HOME=temp, XDG_CONFIG_HOME=str(Path(temp) / '.config'))
            request = json.dumps({'type': 'readConfig'}).encode()
            result = subprocess.run(
                ['python3', str(ROOT / 'packaging' / 'yt-unsub-detector-native-host')],
                input=struct.pack('<I', len(request)) + request,
                capture_output=True, env=env, check=True,
            )
            length = struct.unpack('<I', result.stdout[:4])[0]
            response = json.loads(result.stdout[4:4 + length])
            self.assertTrue(response['ok'])
            self.assertFalse(response['configured'])
            self.assertTrue(response['configPath'].endswith('google-drive.json'))
            self.assertTrue(response['keyPath'].endswith('service-account.json'))
            self.assertNotIn('linkPath', response)
            self.assertEqual(result.stderr, b'')


if __name__ == '__main__':
    unittest.main()

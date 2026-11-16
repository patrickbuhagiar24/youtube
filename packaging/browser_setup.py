#!/usr/bin/env python3
"""Pack the extension as CRX3 and register it for Chrome/Chromium on Linux."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import subprocess
import tempfile
import zipfile

HOST_NAME = 'io.github.patrickbuhagiar24.yt_unsub_detector'
HOST_BINARY = '/usr/bin/yt-unsub-detector-native-host'
SHARE = Path('/usr/share/yt-unsub-detector')
STATE = Path('/var/lib/yt-unsub-detector')
EXTERNAL_DIRS = (
    Path('/usr/share/google-chrome/extensions'),
    Path('/usr/share/chromium/extensions'),
)
NATIVE_DIRS = (
    Path('/etc/opt/chrome/native-messaging-hosts'),
    Path('/etc/chromium/native-messaging-hosts'),
)
EXCLUDED = {'drive-config.json', 'google-drive.json', 'service-account.json'}
# Previous versions could create these shared browser directories with mode 0700.
SHARED_DIRS = (
    Path('/usr/share/google-chrome'), *EXTERNAL_DIRS[:1],
    Path('/usr/share/chromium'), *EXTERNAL_DIRS[1:],
    Path('/etc/opt'), Path('/etc/opt/chrome'), NATIVE_DIRS[0],
    Path('/etc/chromium'), NATIVE_DIRS[1],
)


def repair_private_shared_dirs(directories=SHARED_DIRS, owner=0) -> None:
    """Repair only root-owned 0700 browser directories, never following symlinks."""
    for path in directories:
        try:
            # Do not alter paths reached through a symlink in any ancestor.
            if any(part.is_symlink() for part in (path, *path.parents)):
                continue
            info = path.lstat()
            if stat.S_ISDIR(info.st_mode) and info.st_uid == owner and stat.S_IMODE(info.st_mode) == 0o700:
                path.chmod(0o755)
        except FileNotFoundError:
            continue


def _varint(value: int) -> bytes:
    out = bytearray()
    while value > 0x7F:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def _field(number: int, data: bytes) -> bytes:
    return _varint((number << 3) | 2) + _varint(len(data)) + data


def extension_id(public_key_der: bytes) -> str:
    digest = hashlib.sha256(public_key_der).digest()[:16]
    return ''.join(chr(ord('a') + nibble) for byte in digest for nibble in (byte >> 4, byte & 15))


def _zip_extension(source: Path) -> tuple[bytes, str]:
    manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
    version = manifest['version']
    with tempfile.TemporaryDirectory(prefix='ytuc-crx-') as temp:
        archive = Path(temp) / 'extension.zip'
        with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
            for path in sorted(source.rglob('*')):
                if not path.is_file() or path.name in EXCLUDED or path.is_symlink():
                    continue
                relative = path.relative_to(source).as_posix()
                info = zipfile.ZipInfo(relative, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                bundle.writestr(info, path.read_bytes())
        return archive.read_bytes(), version


def build_crx(source: Path, key: Path, output: Path) -> tuple[str, str]:
    """Create a deterministic CRX3 signed with RSA PKCS#1 v1.5 / SHA-256."""
    public = subprocess.run(
        ['openssl', 'pkey', '-in', str(key), '-pubout', '-outform', 'DER'],
        check=True, capture_output=True,
    ).stdout
    crx_id = hashlib.sha256(public).digest()[:16]
    signed_data = _field(1, crx_id)
    archive, version = _zip_extension(source)
    payload = b'CRX3 SignedData\x00' + struct.pack('<I', len(signed_data)) + signed_data + archive
    with tempfile.TemporaryDirectory(prefix='ytuc-sign-') as temp:
        payload_path = Path(temp) / 'payload.bin'
        payload_path.write_bytes(payload)
        signature = subprocess.run(
            ['openssl', 'dgst', '-sha256', '-sign', str(key), str(payload_path)],
            check=True, capture_output=True,
        ).stdout
    proof = _field(1, public) + _field(2, signature)
    header = _field(2, proof) + _field(10000, signed_data)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix('.crx.tmp')
    temporary.write_bytes(b'Cr24' + struct.pack('<II', 3, len(header)) + header + archive)
    os.chmod(temporary, 0o644)
    os.replace(temporary, output)
    return extension_id(public), version


def _write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    os.chmod(temporary, 0o644)
    os.replace(temporary, path)


def register(extension: str, version: str, crx: Path, external_dirs=EXTERNAL_DIRS, native_dirs=NATIVE_DIRS) -> None:
    for directory in external_dirs:
        _write_json(directory / f'{extension}.json', {
            'external_crx': str(crx),
            'external_version': version,
        })
    manifest = {
        'name': HOST_NAME,
        'description': 'Reads per-user YT Unsub Detector Google Drive configuration.',
        'path': HOST_BINARY,
        'type': 'stdio',
        'allowed_origins': [f'chrome-extension://{extension}/'],
    }
    for directory in native_dirs:
        _write_json(directory / f'{HOST_NAME}.json', manifest)


def main() -> int:
    key = STATE / 'crx-private.pem'
    crx = SHARE / 'yt-unsub-detector.crx'
    extension, version = build_crx(SHARE / 'extension', key, crx)
    repair_private_shared_dirs()
    register(extension, version, crx)
    _write_json(STATE / 'state.json', {'extensionId': extension, 'version': version})
    print(f'Registered YT Unsub Detector {version} ({extension}) for Chrome/Chromium.')
    print('Restart the browser to finish installation.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

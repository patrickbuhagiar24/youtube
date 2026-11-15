#!/usr/bin/env python3
"""Write Release checksums for every index in an APT distribution directory."""
from __future__ import annotations

from email.utils import format_datetime
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import sys


def write_release(distribution: Path, suite: str) -> None:
    files = sorted(p for p in distribution.rglob('*') if p.is_file() and p.name not in ('Release', 'Release.gpg', 'InRelease'))
    if not files:
        raise ValueError('Cannot publish an archive without package indices.')
    fields = [
        'Origin: YT Unsub Detector',
        'Label: YT Unsub Detector',
        f'Suite: {suite}',
        f'Codename: {suite}',
        f'Date: {format_datetime(datetime.now(timezone.utc), usegmt=True)}',
        'Architectures: all',
        'Components: main',
        'Description: YT Unsub Detector packages for Ubuntu 26.10',
        'Acquire-By-Hash: no',
    ]
    for label, algorithm in (('MD5Sum', 'md5'), ('SHA1', 'sha1'), ('SHA256', 'sha256'), ('SHA512', 'sha512')):
        fields.append(label + ':')
        for path in files:
            data = path.read_bytes()
            digest = hashlib.new(algorithm, data).hexdigest()
            fields.append(f' {digest} {len(data):16d} {path.relative_to(distribution).as_posix()}')
    (distribution / 'Release').write_text('\n'.join(fields) + '\n', encoding='utf-8')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(f'Usage: {sys.argv[0]} DISTRIBUTION_DIRECTORY SUITE')
    write_release(Path(sys.argv[1]), sys.argv[2])

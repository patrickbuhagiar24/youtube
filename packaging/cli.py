#!/usr/bin/env python3
"""User-facing helper for the APT-installed browser extension."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

from config_store import CONFIG_NAME, KEY_NAME, ensure_config, status

SYSTEM_EXTENSION = Path('/usr/share/yt-unsub-detector/extension')


def packaged_version() -> str:
    try:
        return json.loads((SYSTEM_EXTENSION / 'manifest.json').read_text(encoding='utf-8'))['version']
    except (OSError, ValueError, KeyError):
        return 'unknown'


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Manage per-user Google Drive configuration for YT Unsub Detector.')
    parser.add_argument('command', nargs='?', default='config', choices=('config', 'status'))
    parser.add_argument('--version', action='store_true', help='Print the packaged extension version.')
    args = parser.parse_args(argv)
    if args.version:
        print(f'YT Unsub Detector {packaged_version()}')
        return 0
    try:
        if os.geteuid() == 0:
            raise ValueError('Run this command as your desktop user, without sudo.')
        if args.command == 'config':
            path = ensure_config()
            print(f'Google Drive configuration: {path}')
            print(f'Service account key: {path.parent / KEY_NAME}')
            print(f'Edit {CONFIG_NAME} and {KEY_NAME}, then restart the browser or click the extension sync button.')
            return 0
        info = status()
        print(f'Packaged version: {packaged_version()}')
        print(f'Configuration file: {info["configPath"]}')
        print(f'Drive link configured: {"yes" if info["configured"] else "no"}')
        print(f'Service account key file: {info["keyPath"]}')
        print(f'Service account key present: {"yes" if info["keyPresent"] else "no"}')
        if info['error']:
            print(f'Error: {info["error"]}', file=sys.stderr)
            return 1
        return 0
    except (OSError, ValueError) as error:
        print(f'Error: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

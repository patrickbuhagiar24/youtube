#!/usr/bin/env python3
"""Per-user Google Drive configuration, stored outside the browser extension.

The user configuration folder contains only two files:
  google-drive.json    -> { "link": "<shared YouTube.json file link>" }
  service-account.json -> JSON key downloaded from Google Cloud

The older drive-config.json wrapper is migrated into these two files and removed.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import tempfile

APP_DIR = 'yt-unsub-detector'
CONFIG_NAME = 'google-drive.json'
KEY_NAME = 'service-account.json'
OLD_CONFIG_NAME = 'drive-config.json'
TEMPLATE = {'link': 'PASTE_FILE_LINK_HERE'}
LEGACY_APP_DIR = Path(APP_DIR) / 'extension'
PLACEHOLDER = re.compile(r'^[A-Z]+(?:_[A-Z]+)+$')


def config_home() -> Path:
    home = Path.home()
    base = Path(os.environ.get('XDG_CONFIG_HOME', str(home / '.config')))
    if not base.is_absolute():
        raise ValueError('XDG_CONFIG_HOME must be an absolute path.')
    return base / APP_DIR


def _reject_symlinks(path: Path) -> None:
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise ValueError(f'Refusing a symlink in the configuration path: {parent}')


def _private_write(path: Path, text: str) -> None:
    """Replace a file atomically without ever exposing it as world-readable."""
    fd, temporary = tempfile.mkstemp(prefix=f'.{path.name}-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(text)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def _normalize_link(value) -> str:
    if not isinstance(value, str):
        return ''
    value = value.strip()
    return '' if not value or PLACEHOLDER.match(value) else value


def _extract_link(content) -> str:
    if isinstance(content, str):
        return _normalize_link(content)
    if isinstance(content, dict):
        return _normalize_link(content.get('link', ''))
    return ''


def _is_file_reference(value: str) -> bool:
    """A file name or path is a reference; a URL or bare Drive file ID is inline."""
    if '://' in value:
        return False
    if len(value) >= 10 and all(character.isalnum() or character in '_-' for character in value):
        return False
    return True


def _resolve(directory: Path, reference: str) -> Path:
    candidate = Path(reference).expanduser()
    return candidate if candidate.is_absolute() else directory / candidate


def _key_is_empty(path: Path) -> bool:
    if not path.exists():
        return True
    return _read_json(path) == {}


def _migrate_key(directory: Path, source: Path, reference) -> None:
    """Copy an older key into service-account.json so only two files remain."""
    target = directory / KEY_NAME
    if not _key_is_empty(target):
        return
    if isinstance(reference, dict):
        _private_write(target, json.dumps(reference, indent=2) + '\n')
        return
    if not isinstance(reference, str) or not reference.strip():
        return
    old = _resolve(source, reference.strip())
    if not old.is_file() or old.is_symlink():
        return
    content = _read_json(old)
    if not isinstance(content, dict) or not content:
        return
    _private_write(target, json.dumps(content, indent=2) + '\n')
    if old.parent == directory and old.name != KEY_NAME:
        old.unlink(missing_ok=True)


def _migrate_old_config(directory: Path, source: Path | None = None) -> None:
    """Fold the old wrapper into google-drive.json, then remove the wrapper."""
    source = source or directory
    old = source / OLD_CONFIG_NAME
    if not old.is_file() or old.is_symlink():
        return
    config = _read_json(old)
    config = config if isinstance(config, dict) else {}

    link = config.get('link', config.get('file', ''))
    if isinstance(link, str) and _is_file_reference(link.strip()):
        target = _resolve(source, link.strip())
        link = _extract_link(_read_json(target)) if target.is_file() and not target.is_symlink() else ''
    else:
        link = _extract_link(link)

    target = directory / CONFIG_NAME
    current = _read_json(target)
    current = current if isinstance(current, dict) else {}
    if not _extract_link(current) and link:
        current['link'] = link
        _private_write(target, json.dumps(current, indent=2) + '\n')

    _migrate_key(directory, source, config.get('serviceAccount'))
    if source == directory:
        old.unlink(missing_ok=True)


def _migrate_legacy_extension(directory: Path) -> None:
    """One-time copy from the old per-user unpacked extension, if present."""
    data_home = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local' / 'share')))
    legacy = data_home / LEGACY_APP_DIR
    if not legacy.is_dir():
        return
    for name in (CONFIG_NAME, KEY_NAME):
        old, new = legacy / name, directory / name
        if not new.exists() and old.is_file() and not old.is_symlink():
            shutil.copyfile(old, new)
            new.chmod(0o600)
    _migrate_old_config(directory, legacy)


def ensure_config() -> Path:
    """Create private, editable defaults on first use; never overwrite user data."""
    directory = config_home()
    _reject_symlinks(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    _migrate_legacy_extension(directory)
    _migrate_old_config(directory)
    for name, text in ((CONFIG_NAME, json.dumps(TEMPLATE, indent=2) + '\n'), (KEY_NAME, '{}\n')):
        path = directory / name
        if not path.exists():
            _private_write(path, text)
    return directory / CONFIG_NAME


def _read_key(path: Path):
    if not path.is_file() or path.is_symlink():
        return None, None
    try:
        text = path.read_text(encoding='utf-8').strip()
        key = json.loads(text) if text and text != '{}' else None
    except (OSError, ValueError):
        return None, f'{path} is not readable as a valid JSON key file.'
    return key, None


def read_config() -> dict:
    """Return a native-messaging response. Never include private key material in errors."""
    path = ensure_config()
    key_path = path.parent / KEY_NAME
    content = _read_json(path)
    if content is None:
        return {'ok': False, 'error': f'{path} is not readable as valid JSON.', 'configPath': str(path), 'keyPath': str(key_path)}
    if isinstance(content, str):
        link = _normalize_link(content)
    elif isinstance(content, dict):
        link = _extract_link(content)
    else:
        return {'ok': False, 'error': f'{path} must contain a JSON object or a JSON string with the file link.', 'configPath': str(path), 'keyPath': str(key_path)}

    key, key_error = _read_key(key_path)
    result = {'configPath': str(path), 'keyPath': str(key_path)}
    if key_error:
        return {'ok': False, 'error': key_error, **result}
    return {'ok': True, 'configured': bool(link), 'link': link, 'key': key, **result}


def status() -> dict:
    result = read_config()
    directory = config_home()
    return {
        'configPath': result.get('configPath', str(directory / CONFIG_NAME)),
        'keyPath': result.get('keyPath', str(directory / KEY_NAME)),
        'configured': bool(result.get('configured')),
        'keyPresent': result.get('key') is not None,
        'error': result.get('error', ''),
    }

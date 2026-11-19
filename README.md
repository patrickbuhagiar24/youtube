# YOUSUB

A Google Chrome browser extension (Manifest V3) that marks videos and channels you are not subscribed to across YouTube. All interface text, source comments, documentation, and exported data are in English.

This project is **only a browser extension**: there is no CLI command, native messaging host, .deb package, or system installer.

## Features

- Highlight channels you are not subscribed to, or previously unsubscribed from.
- Subscribe and unsubscribe directly from video thumbnails, including collaboration videos.
- Put unsubscribed channels first and hide duplicate videos.
- Dim or hide selected subscription groups.
- Refresh your subscription list and export it as CSV.
- Optionally sync unsubscribe history between devices using a JSON file in your own Google Drive.

## Requirements

- Google Chrome 111 or newer (Manifest V3).
- A YouTube account for subscription detection.

## Install from source

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome and enable **Developer mode**.
3. Click **Load unpacked** and select this repository's root folder (the folder that contains `manifest.json`).
4. Pin **YOUSUB** to the toolbar, open <https://www.youtube.com>, and sign in.

A source checkout needs no installer. Signed packages are distributed only through the APT repository below; no GitHub Releases are published.

## Signed builds

The **Build signed YOUSUB extension** workflow (`.github/workflows/build-extension.yml`) runs on manual dispatch and on `v*` tags. It uses the repository secret **`YOUSUB_CRX_PRIVATE_KEY`** — a dedicated RSA private key in PEM format — to sign a CRX3, writes the matching public key into the manifest of an unpacked ZIP, and builds an extension-only Debian package that registers the CRX. The CRX, ZIP, `.deb`, public PEM, and `checksums.txt` are uploaded as the `yousub-extension` artifact; the APT publisher consumes that artifact directly.

**Do not reuse the signing key of another extension project.** Chrome derives the ID from the public key, so two projects using the same key get the same ID and both packages try to register the same `/usr/share/*/extensions/<id>.json` file. That collision prevents Chrome and `dpkg` from distinguishing them. Generate a separate key for YOUSUB and back it up privately; the resulting ID is printed in the build log and stored in `/usr/share/yousub/yousub-id.txt`.

Because every build uses the same secret key, all users get the **same extension ID**, and reinstalling or upgrading keeps that ID and the browser storage that belongs to it. The private key is written only to a temporary runner file with `0600` permissions; it is never printed, committed, or included in an artifact.

## Install from the APT repository

The **Publish signed APT repository** workflow publishes a signed repository to <https://patrickbuhagiar24.github.io/youtube/> whenever a `v*` tag is pushed. The `stable` suite is architecture-independent; the older `stonking` suite is also published as an alias for configurations created by earlier versions.

Obtain the **full 40-character signing-key fingerprint** from a trusted maintainer channel independent of this website. Do not use a fingerprint downloaded only from the same site as your sole verification. The commands below require Bash, `curl`, `gpg` (from `gnupg`), and `sudo`; they download the key into a private temporary directory and ask you to confirm the trusted fingerprint before changing system files.

```bash
(
  set -euo pipefail
  tmpdir=$(mktemp -d)
  trap 'rm -rf "$tmpdir"' EXIT
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    -o "$tmpdir/archive-keyring.gpg" \
    https://patrickbuhagiar24.github.io/youtube/archive-keyring.gpg
  fingerprint=$(gpg --batch --with-colons --show-keys "$tmpdir/archive-keyring.gpg" |
    awk -F: '$1 == "pub" { count++; want = 1; next }
      want && $1 == "fpr" { print $10; want = 0 }
      END { if (count != 1) exit 1 }')
  [[ "$fingerprint" =~ ^[A-F0-9]{40}$ ]] || { echo 'Invalid key fingerprint.' >&2; exit 1; }
  printf 'Downloaded key fingerprint: %s\n' "$fingerprint"
  read -r -p 'Enter the independently verified fingerprint: ' expected
  expected=${expected//[[:space:]]/}
  [[ "${expected^^}" == "$fingerprint" ]] || { echo 'Fingerprint mismatch; nothing installed.' >&2; exit 1; }
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    -o "$tmpdir/yousub.sources" \
    https://patrickbuhagiar24.github.io/youtube/yousub.sources
  sudo install -d -m 0755 /etc/apt/keyrings
  sudo install -m 0644 "$tmpdir/archive-keyring.gpg" /etc/apt/keyrings/yousub.gpg
  sudo install -m 0644 "$tmpdir/yousub.sources" /etc/apt/sources.list.d/yousub.sources
  sudo apt update
  sudo apt install yousub
)
```

Restart **all** Chrome windows, then open <https://www.youtube.com> and sign in. If the extension does not appear, check `chrome://extensions` with Developer mode enabled; external registrations are read from `/usr/share/google-chrome/extensions/` (and `/etc/chromium/extensions/` for Chromium) at browser startup. To remove the registration later, run `sudo apt remove yousub`; Chrome profile data is left untouched.

The package only places the signed CRX under `/usr/share/yousub` and registers it for Chrome and Chromium. It installs **no CLI command, native messaging host, or per-user configuration files**. Because the CRX is signed with the repository key, every machine that installs this package gets the same extension ID.

### If the extension is not added automatically

Chrome reads the registration file **only at browser startup** and only in the Chrome build that uses the system paths. Check the browser first:

```bash
google-chrome --version
readlink -f "$(command -v google-chrome)"
pgrep -a chrome
```

The path must be the Google Chrome `.deb` binary (normally `/opt/google/chrome/chrome`). Snap/Flatpak Chrome and Chromium do not read the Google Chrome registration path. If several Chrome processes are still listed, close them all before starting the browser again.

To confirm that the package registration itself works, start Chrome with a new, empty profile:

```bash
mkdir -p /tmp/yousub-chrome-profile
google-chrome --user-data-dir=/tmp/yousub-chrome-profile --no-first-run --no-default-browser-check
```

Open `chrome://extensions` in that window. If YOUSUB appears there, the package is fine and the regular profile has blocked the external installation. Chrome does this when an externally installed extension was previously removed through the Extensions page; it stores the ID in `extensions.external_uninstalls` and never re-adds it automatically.

Close **all** Chrome windows, back up the profile preferences, and remove only that ID from the blocklist:

```bash
python3 - <<'PY'
import json
import pathlib
import shutil

root = pathlib.Path.home() / '.config/google-chrome'
ident = open('/usr/share/yousub/yousub-id.txt').read().strip()
for pref in [root / 'Default/Preferences', *root.glob('Profile */Preferences')]:
    if not pref.exists():
        continue
    data = json.loads(pref.read_text())
    ext = data.get('extensions', {})
    entries = ext.get('external_uninstalls')
    if isinstance(entries, dict):
        changed = entries.pop(ident, None) is not None
    elif isinstance(entries, list):
        kept = [x for x in entries if (x.get('id') if isinstance(x, dict) else x) != ident]
        changed = len(kept) != len(entries)
        ext['external_uninstalls'] = kept
    else:
        continue
    if changed:
        shutil.copy2(pref, str(pref) + '.yousub-backup')
        pref.write_text(json.dumps(data, separators=(',', ':')))
        print(f'Unblocked YOUSUB in {pref}')
PY
```

Start Chrome again and check `chrome://extensions`. The preferences backup can be restored while Chrome is closed if needed. A fresh Chrome profile is a supported alternative if you do not want to edit preferences.

## Extension ID and the CRX key

A Chrome extension ID is derived from its **public signing key**: Chrome takes the first 16 bytes of the SHA-256 hash of the DER-encoded public key and maps each nibble to `a`–`p`. The ID therefore stays the same when the extension is reinstalled **as long as the same key is used**. If the key changes or is lost, the ID changes and Chrome treats it as a different extension, so its browser storage (settings, subscription list, and local unsubscribe history) does not carry over.

- **Unpacked installation (as above):** the signed ZIP built by the workflow already contains the `key` field, so it keeps the build ID wherever it is extracted. A raw source checkout has no `key`: Chrome then derives the ID from the folder path, and moving or renaming the folder can change it. To pin the ID of a source build, generate a key pair once and add the public key to the manifest:

  ```bash
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out yousub.pem
  openssl pkey -in yousub.pem -pubout -outform DER | base64 -w0
  ```

  Put the printed value in a top-level `"key": "..."` field in `manifest.json`. Keep `yousub.pem` private and backed up; it is ignored by Git. Every installation that uses the same public key gets the same ID, even from a different folder.

- **Packed CRX:** sign every new CRX with the same private key (for example `chrome.exe --pack-extension=<folder> --pack-extension-key=yousub.pem`). Chrome Web Store uploads likewise keep the ID when the same upload key is reused.

Reinstalling with the same key keeps the ID and browser storage. Clearing the Chrome profile, removing the extension together with its site data, or switching keys does not. Data written to your own Google Drive file is independent of the extension ID.

## Google Drive sync (optional)

Google Drive sync is disabled until both settings are provided in the extension popup. The original `google-drive.json` and `service-account.json` files can be loaded directly with the file pickers in the popup; their contents are read locally in the browser and saved as the popup settings. No files outside the browser and no helper application are used.

1. Create a service account in Google Cloud and enable the Google Drive API.
2. Download its JSON key.
3. Upload `YouTube.json` to **your own** Google Drive. Share that file with the service account's `client_email` as an **Editor**. A new service account cannot create files using its own storage quota.
4. Open the extension popup → **☁️ Google Drive sync** and select `google-drive.json` (the file containing the shared **file** link, not a folder link) and `service-account.json` with the two file pickers. These are the only inputs: when both files are valid, their settings are saved and synced automatically.

Both values are saved in `chrome.storage.local` for this browser profile only; the key is never placed in `chrome.storage.sync`, in source code, or in the extension archive. **Local extension storage is not encrypted**: keep your Chrome profile private, remove personal keys before sharing a profile, and never commit a real key to a repository. **Remove saved configuration** in the popup deletes both values.

The sync button in the popup runs an immediate sync. The service worker also syncs on a 15-minute alarm and after local unsubscribe changes.

### Data format

Drive files use `application`, `description`, `updatedAt`, `unsubscribeCount`, and channel fields `id`, `name`, `url`, `status`, and `date`. Status values are `unsubscribed` and `resubscribed`. Only this English format is read and written. Keep a backup of your Drive file before upgrading.

## Privacy and behavior

Subscription data is stored in browser extension storage. YouTube requests use your current browser session. If configured, unsubscribe history and channel names/URLs are sent to your Google Drive file using your service account. Sorting may automatically load additional YouTube results, up to the built-in limit. This project uses YouTube page internals that may change; refresh the page or list if detection stops working.

## Development

No build step is required. Check and test the source with Node.js 18 or newer:

```bash
node --check background.js
node --check shared.js
node --check drive.js
node --check content/content.js
node --check content/main-world.js
node --check popup/popup.js
node --test tests/*.test.cjs
```

The CI workflow runs the same checks for every push and pull request.

## License

MIT. See [LICENSE](LICENSE).

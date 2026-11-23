# Yousub

A Chrome extension (Manifest V3) that marks videos and channels you are **not subscribed to** across YouTube, so you can see at a glance what you are missing. All interface text is in English. It is installed from the signed APT repository below.

## Features

- Highlight channels you are not subscribed to, or mark previously unsubscribed channels with a yellow outline only.
- Subscribe and unsubscribe directly from video thumbnails, including collaboration videos.
- Get the same subscribe/unsubscribe button to the right of YouTube's own button on watch pages and channel cards. YouTube's own button keeps its behavior.
- Put unsubscribed channels first and hide duplicate videos.
- Dim or hide selected subscription groups.
- Export your subscription list as CSV.
- Optionally sync unsubscribe history between devices using a JSON file in your own Google Drive.

## Requirements

- Google Chrome 116 or newer (or Chromium).
- A YouTube account for subscription detection.

## Install from the APT repository

The signed repository is published at <https://patrickbuhagiar24.github.io/youtube/>. The `stable` suite is architecture-independent; the older `stonking` suite is kept as an alias for earlier configurations.

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

Afterwards, upgrades arrive with `sudo apt update && sudo apt upgrade`, and `sudo apt remove yousub` removes the registration; Chrome profile data (settings, subscription list, history) is left untouched.

Restart **all** Chrome windows, then open <https://www.youtube.com> and sign in. If the extension does not appear, check `chrome://extensions` with Developer mode enabled; external registrations are read from `/usr/share/google-chrome/extensions/` (and `/etc/chromium/extensions/` for Chromium) at browser startup.

### If the extension is not added automatically

Chrome reads the registration file **only at browser startup** and only in the Chrome build that uses the system paths. Check the browser first:

```bash
dpkg -L yousub          # files installed by the package
cat /usr/share/yousub/yousub-id.txt
```

- If `chrome://extensions` lists the extension but it is disabled, enable it there.
- If Chrome removed it earlier through the Extensions page, Chrome stores it in `extensions.external_uninstalls` and never re-adds it on its own. Close Chrome, edit the profile's `Preferences` and remove the extension ID from that list, then start Chrome again.
- A fresh Chrome profile is a supported alternative if you do not want to edit preferences.

## Google Drive sync (optional)

Google Drive sync is disabled until you choose a configuration **folder**. Unsubscribe history is kept locally **only while Drive sync is configured**. Click the extension icon to open the side panel, then click 📁 at the right of the **previously unsubscribed channels** count and choose the folder that holds your JSON files. Only the **top level** of that folder is read (sub-folders are not entered), and the two files are recognised by their content, so their names do not matter. When everything is found the row shows **✅** (hover for the account, the folder name, and which files were used) and the button becomes 🔁 (**Choose another configuration folder**); syncing itself is automatic. If a file is missing the row shows **⚠️** and the line below names it, for example `Missing JSON file: yousub-google-drive.json`.

The configuration is read once and then used from the cache in `chrome.storage.local`, so opening the side panel never touches the folder and never asks the browser for permission again. Choose the folder again with 🔁 after changing a file inside it.

1. Create a service account in Google Cloud and enable the Google Drive API.
2. Download its JSON key.
3. Upload `YouTube.json` to **your own** Google Drive and share it with the service account's `client_email` as an **Editor**. Put its file link in a JSON file such as `yousub-google-drive.json`:

   ```json
   {"link": "https://drive.google.com/file/d/FILE_ID/view?usp=sharing"}
   ```

4. Put the service account JSON key and `yousub-google-drive.json` in one folder on this computer (the same folder, not a sub-folder), then choose it with 📁. Nothing is uploaded for this step and there is no manifest to write: Yousub scans the top level of that folder for a JSON object with `"type": "service_account"` and one with a `link` field.

The files are read once and the settings are stored in `chrome.storage.local`, which is not encrypted. Editing them later only needs the panel to be opened again, which re-reads the remembered folder.

### When the sync runs

Without any button press, the extension syncs automatically:

- **15-minute alarm** — every 15 minutes in the background.
- **After a local unsubscribe** — pushed 3 seconds after the last change (rapid changes are batched).
- **On a YouTube page load** — the first page that opens pulls changes, at most once every 2 minutes.
- **On browser start and on install/update** — settings are re-read, sync runs once, and local history that exists without a configuration is cleared.

Only one sync runs at a time. It signs in with the service account, reads `YouTube.json`, merges the most recent event per channel, writes back only when something changed, and merges once more so local changes made during the sync survive. Failures appear in the side panel instead of retrying in a loop.

### Google Drive row in the side panel

- **Configuration mark** (right of the unsubscribe count): `❌` until a folder is read, then `✅`; hover it for the account, the folder and the files found. `⚠️` means a file is missing (named in the line below).
- **📁 / 🔁 button** (far right of the same row): 📁 opens the folder picker; once configured it becomes 🔁 and replaces the saved configuration with the contents of the newly chosen folder. There is no separate "Google Drive sync" box.
- **No manual sync button**: syncing runs automatically (see above), and the status line reports its progress.

### Subscribed channel count

The summary card shows the number of channels in the stored subscription list, formatted with `en-US` separators (for example `1,250`). It is read from browser storage, so it stays visible when the active tab is not YouTube, and it updates whenever the list refreshes or a subscribe/unsubscribe action changes it. `–` means no list has been stored yet; the line below shows the list status (`✅ Complete list` / `⚠️ Incomplete list`) and when it was updated.

### Data format

Drive files use `application`, `description`, `updatedAt`, `unsubscribeCount`, and channel fields `id`, `name`, `url`, `status`, and `date`. Status values are `unsubscribed` and `resubscribed`. Only this English format is read and written. Keep a backup of your Drive file before upgrading.

## Sorting, autoload, and how videos are marked

`Unsubscribed channels first & hide duplicate videos` uses CSS `order`, so YouTube elements are never moved. On Home, Search, and watch-page sidebars the extension keeps YouTube's own continuation loader inside a 2 px invisible box, so YouTube fetches the next pages without you scrolling. Fetching stops at the limit chosen under `Automatically load videos for sorting` (Off, 100, 250, or 500 marked videos), after 15 seconds without new items, or when the list is exhausted; normal scrolling then resumes. The setting only applies while sorting is on.

Marking is controlled by `Display mode` and the two colours:

- **Not subscribed** (`unsub`, default red `#ff3d00`): coloured outline plus a `+` button in the thumbnail corner, and the same `+` to the right of YouTube's own Subscribe button.
- **Previously unsubscribed** (`left`, default yellow `#ffd400`): a channel in the unsubscribe history that is no longer in your subscription list. It gets the yellow outline only — no `+`, `−`, or inline button — and sorts after subscribed channels.
- **Subscribed** (`sub`): no outline in `highlight` mode; dimmed in `dim` mode and hidden in `only-unsub` mode.

## If markers do not appear

Run `diagnostics.js` in the YouTube tab: press F12 (Developer tools) → **Console**, paste the whole file, press Enter. It prints which part is missing and which version is really running in the page: a page console cannot see extension APIs, so the checks look for the trace the extension leaves in the page (`data-yousub-*` attributes and `yousub-*` classes). "0. console type: inside the page" is expected. It changes no settings; share its output when asking for help.

## Keyboard

Yousub adds **no keyboard shortcuts or hotkeys** — there is no `commands` entry in the manifest and no key listener in the page or in the side panel. Everything is a mouse/touch action:

- Click the `+` / `−` in a thumbnail corner (the `−` follows the cursor when hovering a subscribed video).
- Click the `+` / `−` placed to the right of YouTube's own Subscribe button — in cards, and also on a watch page or a channel header, where that button is not part of any video card.
- Toggle the extension, change modes and colours, or choose the Drive configuration folder in the side panel.

YouTube's own shortcuts (space, `k`, `j`, `l`, `f`, `m`, `c`, `shift+n`, etc.) keep working untouched.

## Privacy and behavior

Subscription data is stored in browser extension storage. YouTube requests use your current browser session. If configured, unsubscribe history and channel names/URLs are sent to your Google Drive file using your service account. Sorting may automatically load additional YouTube results; choose Off, 100, 250 (default), or 500 in Settings. Subscription lists load on first use, when changing accounts, and after detected subscription actions; pressing YouTube's own Subscribe/Unsubscribe button only applies the change YouTube already made, with no extra request or refresh; there is no periodic subscription-list refresh. Drive history sync remains separate. This project uses YouTube page internals that may change; if detection stops working, the extension reloads a page restored from the back/forward cache and retries a failed list refresh by itself.

## Building and development

No build step is required. Check and test the source with Node.js 18 or newer:

```bash
node --check background.js
node --check shared.js
node --check drive.js
node --check content/content.js
node --check content/main-world.js
node --check popup/popup.js
node --check folder-config.js
node --test tests/*.test.cjs
```

Release workflow — **no version tags and no GitHub Releases**; GitHub Pages is the only channel:

- Merging into `main` runs **Publish signed APT repository** (`.github/workflows/publish-apt.yml`), which calls **Build signed Yousub extension** (`.github/workflows/build-extension.yml`) and then deploys the signed repository to GitHub Pages in the same run. The same workflow can be started by hand from the Actions tab.
- The build signs a CRX3 with the repository secret `YOUSUB_CRX_PRIVATE_KEY`, writes the public key into the manifest of an unpacked ZIP, and builds an extension-only Debian package that registers the CRX. The CRX, ZIP, `.deb`, public PEM, and `checksums.txt` are uploaded as the `yousub-extension` artifact for that run.
- The version comes from `manifest.json`. If that version is already on Pages, the deploy is skipped, so pushes that do not change the version do not redeploy the repository.

Chrome derives the extension ID from the public signing key, so every build keeps the same ID and existing browser storage. The ID is printed in the build log, stored in `/usr/share/yousub/yousub-id.txt`, and published as <https://patrickbuhagiar24.github.io/youtube/extension-id.txt>. Never reuse the signing key of another extension project: two packages with the same key try to register the same file. Run Chrome with the extension loaded unpacked for local testing (`chrome://extensions` → Developer mode → **Load unpacked** → repository root).

## License

MIT. See [LICENSE](LICENSE).

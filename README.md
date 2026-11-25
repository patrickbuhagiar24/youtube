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

The signed repository is published at <https://patrickbuhagiar24.github.io/youtube/>. It has a single `stable` suite with the `main` component, architecture-independent (`Architectures: all`).

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

Yousub can keep its unsubscribe history in a JSON file in **your own** Google Drive, and share it
between devices. Without it the history is not kept at all.

The file is read and written as **you** (OAuth 2.0), using the scope
`https://www.googleapis.com/auth/drive`. That scope is the full Drive scope: `drive.file` is narrower
but cannot open `YouTube.json`, because that file is created by you, not by Yousub — Google answers
404 for it. What limits Yousub is your configuration, not the scope: it only ever touches the one file
you name there.

### The configuration file (read once, then kept in the browser)

Click the Yousub icon, click **📄** at the right of the *previously unsubscribed channels* row, and
pick **one** JSON file. Any file name works; what makes it a configuration is the keys:

```json
{
  "yousub-file": "https://drive.google.com/file/d/FILE_ID/view?usp=sharing",
  "client_id": "1234567890-abc.apps.googleusercontent.com",
  "client_secret": "GOCSPX-…"
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `yousub-file` | yes | link to **YouTube.json** in your Drive (right-click the file → Share → Copy link) |
| `client_id` | yes | the OAuth client from the guide below |
| `client_secret` | no | the client's secret. **With** it the sync renews itself in the background for months; **without** it Yousub signs in through your Google session in this browser |

The file is read **once**. Its contents are cached in `chrome.storage.local` and used from then on, so
the file is not needed again — not when the panel opens, and not after the browser is restarted. To
replace the configuration, pick another file; to keep it, leave it where it is (a file that is moved or
deleted later changes nothing). A file that fails validation is reported and **never replaces a
working configuration**.

### Set up Google once (about 10 minutes)

1. **Create the project in Personal mode.** Open <https://console.cloud.google.com/auth/overview> and
   click **Get started** → **Personal mode**. Personal mode is for an app only you use: it needs no
   verification and no security review, shows no "unverified app" warning, and — unlike an External
   app in *Testing* — its tokens do **not** expire after 7 days. It can only be chosen for a new
   project, so if you already made an External app, make a new project instead.
2. **Enable the Drive API** — open <https://console.cloud.google.com/apis/library/drive.googleapis.com>
   and click **Enable**.
3. **Create the OAuth client** — <https://console.cloud.google.com/apis/credentials> →
   **Create credentials** → **OAuth client ID** → type **Web application**.
   Under **Authorized redirect URIs** add exactly:

   ```text
   https://<extension-id>.chromiumapp.org/
   ```

   `chrome://extensions` shows the 32-letter extension ID; the trailing slash matters. With the
   package from this repository the ID is fixed, so this is done once. Copy the **Client ID** and the
   **Client secret**.
   Do not choose the *Chrome Extension* application type: Google accepts it only for extensions
   published in the Chrome Web Store.
4. **Create YouTube.json** in <https://drive.google.com> with:

   ```json
   {"application": "Yousub", "channels": []}
   ```

   Right-click it → **Share** → **Copy link**.
5. **Write the configuration file** anywhere on this computer, for example `yousub-config.json`, with
   the three keys above, then pick it with **📄** in the side panel.

### After the file is read

- Yousub asks Google for permission once (a Google window opens) and then syncs by itself.
- **With `client_secret`**: the access token is renewed from a saved refresh token, so a sync works
  even when Chrome has been closed for a while, and nothing asks you again.
- **Without `client_secret`**: the access token lives about an hour and is renewed silently from your
  Google session. If Google wants to ask, the panel says so: click 📄 and choose the configuration
  file again — that starts one sign-in and needs no other step.
- **Sign out** forgets the token and revokes it at Google. The cached configuration and the Drive file
  stay as they are.
- The saved sign-in survives an extension update: `yousubOAuthTokens` is one of the extension's own
  storage keys, and a copy kept in the browser session area restores it if an older build removed it.

### When the sync does not work

| Message in the panel | What to do |
| --- | --- |
| `"yousub-file" points to a folder` | Copy the link of the **file** (`Share → Copy link`), not of a folder. |
| `"yousub-file" is not a Google Drive file link` | Use the link from `Share → Copy link` for YouTube.json. |
| `"client_id" must look like …` | Copy the whole Client ID, which ends with `.apps.googleusercontent.com`. |
| `Google does not recognise this extension's redirect URL` | Add the exact `https://<extension-id>.chromiumapp.org/` shown in the panel to the client's Authorized redirect URIs. |
| `This Google account cannot edit YouTube.json` | Make sure the file belongs to the account you signed in with, or was shared with Editor access. |
| `The Google Drive API is not enabled` | Step 2 above. |
| `The Google sign-in has expired or was revoked` | Click 📄 and choose the configuration file again to sign in once more. With `client_secret` this is rare; without it, it can happen after a long time without using Google in this browser. |
| `Google rejected the saved sign-in` | Same as above: the rejected token is discarded first, so choosing the file again really does start a new sign-in. |

Nothing in the panel asks you to reload the page: the configuration is cached, and the sync resumes by
itself.

### When the sync runs

Without any button press, the extension syncs automatically:

- **15-minute alarm** — every 15 minutes in the background.
- **After a local unsubscribe** — pushed 3 seconds after the last change (rapid changes are batched).
- **On a YouTube page load** — the first page that opens pulls changes, at most once every 2 minutes.
- **On browser start and on install/update** — settings are re-read, sync runs once (without opening any Google window), and local history that exists without a configuration is cleared.

Only one sync runs at a time. It refreshes the access token if needed, reads `YouTube.json`, merges the most recent event per channel, writes back only when something changed, and merges once more so local changes made during the sync survive. Every Google request is bounded to 20 seconds, so a stalled connection cannot leave the panel on "Syncing…". Failures appear in the side panel instead of retrying in a loop. The background sync never opens a Google window: only choosing the configuration file in the panel does.

### Google Drive row in the side panel

- **📄 button** (far right of the unsubscribe row): opens the configuration form — **Choose file…** picks the JSON file described above, **Sign out** forgets the Google token. There is no status mark and no separate "Google Drive sync" box; the tooltip of the button holds the file name, the account and how the sign-in renews itself.
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
- Toggle the extension, change modes and colours, or choose the Drive configuration file in the side panel.

YouTube's own shortcuts (space, `k`, `j`, `l`, `f`, `m`, `c`, `shift+n`, etc.) keep working untouched.

## Privacy and behavior

Subscription data is stored in browser extension storage. YouTube requests use your current browser session. If configured, unsubscribe history and channel names/URLs are written to your own Google Drive file with the OAuth access you granted (Drive scope, one file only: the one named in your configuration). Sorting may automatically load additional YouTube results; choose Off, 100, 250 (default), or 500 in Settings. Subscription lists load on first use, when changing accounts, and after detected subscription actions; pressing YouTube's own Subscribe/Unsubscribe button only applies the change YouTube already made, with no extra request or refresh; there is no periodic subscription-list refresh. Drive history sync remains separate. This project uses YouTube page internals that may change; if detection stops working, the extension reloads a page restored from the back/forward cache and retries a failed list refresh by itself.

## Building and development

No build step is required, and the extension has no runtime dependencies. Node.js 22 or newer:

```bash
npm install          # once: jsdom, used only by the side-panel tests
npm test             # node --test tests/*.test.cjs
```

`tests/panel.test.cjs` loads the real `popup/popup.html` with the real `popup.js`, `shared.js`, `drive.js` and `config-file.js` inside jsdom and drives the panel the way a person does — clicking 📄, picking a file, reopening the panel — with an in-memory `chrome.storage` and a recorded `chrome.runtime.sendMessage`. It is the guard for the two promises that are otherwise invisible until release: the configuration file is read once and cached forever, and a file that fails validation never replaces a working configuration.

Release workflow — **no version tags and no GitHub Releases**; GitHub Pages is the only channel:

- Merging into `main` runs **Publish signed APT repository** (`.github/workflows/publish-apt.yml`), which calls **Build signed Yousub extension** (`.github/workflows/build-extension.yml`) and then deploys the signed repository to GitHub Pages in the same run. The same workflow can be started by hand from the Actions tab.
- The build signs a CRX3 with the repository secret `YOUSUB_CRX_PRIVATE_KEY`, writes the public key into the manifest of an unpacked ZIP, and builds an extension-only Debian package that registers the CRX. The CRX, ZIP, `.deb`, public PEM, and `checksums.txt` are uploaded as the `yousub-extension` artifact for that run.
- The version comes from `manifest.json`. If that version is already on Pages, the deploy is skipped, so pushes that do not change the version do not redeploy the repository.

Chrome derives the extension ID from the public signing key, so every build keeps the same ID and existing browser storage. The ID is printed in the build log, stored in `/usr/share/yousub/yousub-id.txt`, and published as <https://patrickbuhagiar24.github.io/youtube/extension-id.txt>. Never reuse the signing key of another extension project: two packages with the same key try to register the same file. Run Chrome with the extension loaded unpacked for local testing (`chrome://extensions` → Developer mode → **Load unpacked** → repository root).

## License

MIT. See [LICENSE](LICENSE).

# Yousub

A Manifest V3 Chrome extension that marks the videos and channels you are **not subscribed to** on
YouTube, so you can see at a glance what you are missing. All interface text is in English. It is
installed from the signed APT repository below.

## Features

- Outline every video whose channel you are not subscribed to; channels you left earlier get a yellow
  outline only.
- Subscribe or unsubscribe from the thumbnail corner, including collaboration videos.
- The same `+` / `−` sits to the right of YouTube's own button, in cards, on watch pages, and in
  channel headers.
- Unsubscribed channels first, duplicates hidden.
- Dim or hide subscribed videos.
- Export the subscription list as CSV.
- Keep unsubscribe history in a JSON file in your own Google Drive.
- A click on `+` / `−` repaints every video of that channel on the open page at once, with no reload.

## Requirements

- Google Chrome 116 or newer.
- A YouTube account, for subscription detection.

## Install from the APT repository

The signed repository is published at <https://patrickbuhagiar24.github.io/youtube/>: one `stable`
suite, the `main` component, architecture-independent.

Obtain the **full 40-character signing-key fingerprint** from a trusted maintainer channel, not from
this website alone. The commands need Bash, `curl`, `gpg` and `sudo`; they keep the key in a private
temporary directory and ask you to confirm the fingerprint before touching system files.

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

Upgrades arrive with `sudo apt update && sudo apt upgrade`. `sudo apt remove yousub` removes the
registration and leaves the Chrome profile (settings, subscription list, history) untouched.

Restart **all** Chrome windows, then open <https://www.youtube.com> and sign in. The package
registers the CRX in `/usr/share/google-chrome/extensions/`, a directory Chrome reads only at browser
startup. Chromium is not registered by this package.

### If the extension does not appear

```bash
dpkg -L yousub                    # files installed by the package
cat /usr/share/yousub/extension-id # the extension ID Chrome should show
```

- If `chrome://extensions` lists the extension but it is disabled, enable it there.
- If Chrome removed it earlier from the Extensions page, the ID stays in that profile's
  `extensions.external_uninstalls` list and Chrome never re-adds it. Close Chrome, remove the ID from
  the list in the profile's `Preferences`, then start Chrome again.
- A fresh Chrome profile is a supported alternative.

## Google Drive sync (optional)

Yousub can keep its unsubscribe history in a JSON file in **your own** Google Drive, shared between
devices. Without a configuration the history is not kept at all.

The file is read and written as **you**, with the scope `https://www.googleapis.com/auth/drive`. That
is the full Drive scope: `drive.file` cannot open `YouTube.json`, because you created that file, not
Yousub. What limits Yousub is the configuration, not the scope — it only touches the one file named
there.

### The configuration file

Click the Yousub icon, click **Configuration file…** in the *unsubscribed* row, and pick **one** JSON
file. Any file name works; the keys make it a configuration:

```json
{
  "yousub-file": "https://drive.google.com/file/d/FILE_ID/view?usp=sharing",
  "client_id": "1234567890-abc.apps.googleusercontent.com",
  "client_secret": "GOCSPX-…"
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `yousub-file` | yes | link to **YouTube.json** in your Drive (`Share → Copy link`) |
| `client_id` | yes | the OAuth client created below |
| `client_secret` | no | with it the sync renews itself in the background; without it Yousub signs in through your Google session |

The file is read **once**. Its contents are cached in `chrome.storage.local`, so it is not needed
again — not when the panel opens, not after a restart. Pick another file to replace the configuration;
a file that fails validation is reported and never replaces a working one.

### Set up Google once (about 10 minutes)

1. **Create the project in Personal mode** — <https://console.cloud.google.com/auth/overview> →
   **Get started** → **Personal mode**. It needs no verification or security review, shows no
   "unverified app" warning, and its tokens do not expire after 7 days. It can only be chosen for a
   new project.
2. **Enable the Drive API** — <https://console.cloud.google.com/apis/library/drive.googleapis.com> →
   **Enable**.
3. **Create the OAuth client** — <https://console.cloud.google.com/apis/credentials> →
   **Create credentials** → **OAuth client ID** → **Web application**. Under **Authorized redirect
   URIs** add exactly:

   ```text
   https://<extension-id>.chromiumapp.org/
   ```

   `chrome://extensions` shows the 32-letter ID; the trailing slash matters. With this package the ID
   never changes. Copy the **Client ID** and **Client secret**. Do not choose *Chrome Extension*:
   Google accepts that type only for extensions in the Chrome Web Store.
4. **Create YouTube.json** in <https://drive.google.com>:

   ```json
   {"application": "Yousub", "channels": []}
   ```

   Right-click it → **Share** → **Copy link**.
5. **Write the configuration file** anywhere on this computer, for example `yousub-config.json`, with
   the three keys above, then pick it with **Configuration file…**.

### After the file is read

- Yousub asks Google for permission once, then syncs by itself.
- **With `client_secret`**: the access token is renewed from a saved refresh token, so syncs keep
  working after the browser has been closed, without asking again.
- **Without `client_secret`**: the token lives about an hour and is renewed silently from your Google
  session. If Google wants to ask, the panel says so — pick the configuration file again for one
  sign-in.
- **Signing out** happens at Google: remove Yousub's access at
  <https://myaccount.google.com/permissions>. The cached configuration and the Drive file stay.
- The saved sign-in survives an extension update.

### When the sync does not work

| Message in the panel | What to do |
| --- | --- |
| `"yousub-file" points to a folder` | Copy the link of the file, not of a folder. |
| `"yousub-file" is not a Google Drive file link` | Use the link from `Share → Copy link` for YouTube.json. |
| `"client_id" must look like …` | Copy the whole Client ID; it ends with `.apps.googleusercontent.com`. |
| `Google does not recognise this extension's redirect URL` | Add the exact `https://<extension-id>.chromiumapp.org/` shown in the panel to the client's Authorized redirect URIs. |
| `This Google account cannot edit YouTube.json` | The file must belong to the signed-in account or be shared with Editor access. |
| `The Google Drive API is not enabled` | Step 2 above. |
| `The Google sign-in has expired or was revoked` | Pick the configuration file again to sign in once more. |
| `Google rejected the saved sign-in` | Same as above: the rejected token is discarded first. |

### When the sync runs

Without a button press, the extension syncs on two occasions:

- **After a local unsubscribe** — pushed 3 seconds after the last change, so rapid changes are
  batched.
- **On install/update** — settings are re-read, one sync runs without opening a Google window, and
  local history without a configuration is cleared.

There is no timer, no pull when a page opens, and nothing at browser start: a browser that only reads
never contacts Google by itself. **Configuration file…** is the third way a sync starts, and the only
one that can ask for permission.

One sync runs at a time. It refreshes the token if needed, reads `YouTube.json`, keeps the most recent
event per channel, writes back only when something changed, and merges again so local changes made
during the sync survive. Every Google request is bounded to 20 seconds; failures appear in the panel
instead of retrying in a loop.

### The panel

- **Configuration file…** opens the file picker directly. There is no form, no status mark and no
  separate Drive box; the tooltip holds the file name, the account, and how the sign-in renews.
- **No manual sync button**: syncs run automatically, and the status line reports progress. A line
  with nothing to report stays empty.

### Data format

Drive files use `application`, `description`, `updatedAt`, `unsubscribeCount`, and the channel fields
`id`, `name`, `url`, `status`, `date`. Status values are `unsubscribed` and `resubscribed`. Only this
format is read and written. Back up your Drive file before upgrading.

## Marking and sorting

`Unsubscribed first & hide duplicates` uses CSS `order`, so YouTube elements are never moved. On Home,
Search, and watch sidebars the continuation loader is kept inside an invisible box so YouTube fetches
the next pages without scrolling; loading stops at the limit chosen under `Auto-load for sorting`
(Off, 100, 250, 500 marked videos), after 15 seconds without new items, or at the end of the list.

`Display mode` and the two colours decide the outlines:

- **Not subscribed** (`unsub`, default red `#ff3d00`, labelled *unsubscribed*): outline, a `+` in the
  thumbnail corner, and the same `+` next to YouTube's own button.
- **Previously unsubscribed** (`left`, default yellow `#ffd400`, labelled *history*): yellow outline
  only, no button, sorted after subscribed channels. Only kept while Drive sync is configured.
- **Subscribed** (`sub`): no outline in `highlight` mode, dimmed in `dim` mode, hidden in
  `only-unsub` mode.

The panel follows the system theme; every button, select and switch draws a visible keyboard focus
ring, and transitions are switched off when the system asks for reduced motion.

## Diagnostics

Run `diagnostics.js` in the YouTube tab: F12 → **Console**, paste the whole file, Enter. It prints what
is missing and which version really runs in the page, using the attributes and classes the extension
leaves there. `0. console type: inside the page` is expected. It changes no settings; share the output
when asking for help.

## Keyboard and privacy

Yousub adds no shortcuts: no `commands` entry in the manifest, no key listener. YouTube's own keys keep
working untouched.

Subscription data stays in browser extension storage, and YouTube requests use your browser session.
With a configuration, unsubscribe history and channel names/URLs are written to your Drive file only.
Sorting may load extra YouTube results (Off, 100, 250, 500). The list refreshes on first use, when the
account changes, and after a detected subscription action; YouTube's own Subscribe button is only read,
never triggered. This project relies on YouTube page internals, so a restored page reloads once by
itself and a failed list refresh retries on its own.

## Development

No build step and no runtime dependencies; Node.js 22 or newer:

```bash
npm install          # once: jsdom, ESLint and TypeScript, all development-only
npm test             # node --test tests/*.test.cjs
npm run coverage     # the same suite with line/branch/function minimums
npm run lint         # ESLint (eslint.config.js)
npm run typecheck    # tsc over the real sources (jsconfig.json)
npm run check        # lint + type-check + tests
```

Coverage measures the shipped files: each harness loads the product script with
`vm.runInContext(code, context, { filename })`, and the panel runs in jsdom's own VM context. A harness
without a `filename` (or one using `window.eval`) reports nothing for that file. The thresholds in
`package.json` sit just below today's numbers — a ratchet, not a target.

`tests/panel.test.cjs` drives the real panel against an in-memory `chrome.storage`, and
`tests/live-marking.test.cjs` runs the content script in jsdom to check that a `+` / `−` click repaints
every card of that channel on the page without a reload.

`types/yousub.d.ts` is type-only, and the build copies named files, so neither the config, the types
nor the development dependencies reach the CRX, the ZIP or the `.deb`.

### Release

**No version tags and no GitHub Releases**; GitHub Pages is the only channel.

- Merging into `main` runs **Publish signed APT repository**, which calls **Build signed Yousub
  extension** and deploys the signed repository to Pages in the same run. It can also be started by
  hand from the Actions tab.
- The build signs a CRX3 with the secret `YOUSUB_CRX_PRIVATE_KEY`, writes the public key into the
  manifest of an unpacked ZIP, and builds an extension-only Debian package that registers the CRX. The
  run uploads the CRX, ZIP, `.deb`, PEM and `checksums.txt` as the `yousub-extension` artifact.
- The version comes from `manifest.json`; if it is already on Pages the deploy is skipped.
- The package ships one registration file, `/usr/share/google-chrome/extensions/<id>.json`, and no
  maintainer scripts: dpkg installs, replaces and removes that file by itself. Files that 2.7.5 and
  earlier wrote for Chromium or `/opt` are removed as obsolete on upgrade.

Chrome derives the extension ID from the public signing key, so every build keeps the same ID and the
same browser storage. The ID is printed in the build log, stored in `/usr/share/yousub/extension-id`,
and published as <https://patrickbuhagiar24.github.io/youtube/extension-id.txt>. Never reuse another
project's signing key: two packages with the same key register the same file. For local testing, load
the repository root as an unpacked extension in `chrome://extensions` with Developer mode on.

## License

MIT. See [LICENSE](LICENSE).

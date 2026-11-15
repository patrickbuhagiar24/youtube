# YT Unsub Detector

A Chromium-compatible browser extension that marks videos and channels you are not subscribed to across YouTube. All interface text, source comments, documentation, and newly exported data are in English.

## Features

- Highlight channels you are not subscribed to, or previously unsubscribed from.
- Subscribe and unsubscribe directly from video thumbnails, including collaboration videos.
- Put unsubscribed channels first and hide duplicate videos.
- Dim or hide selected subscription groups.
- Refresh your subscription list and export it as CSV.
- Optionally sync unsubscribe history between devices using a JSON file in your own Google Drive.

Requires Google Chrome or Chromium installed from a `.deb` package on Linux, with Manifest V3 support (Chrome 111 or newer). Snap/Flatpak browser builds and Firefox are not supported by this packaging.

## Install on Ubuntu 26.10 through APT only

Ubuntu 26.10 uses the repository suite **`stonking`**. The project includes a Debian package, a deb822 APT source, and a GitHub Pages publishing workflow. The intended repository URL is:

```text
https://patrickbuhagiar24.github.io/youtube/
```

**Availability:** these commands work after the maintainer completes [APT repository publishing](docs/PUBLISHING_APT.md), including enabling GitHub Pages under **Settings → Pages → Build and deployment → Source: GitHub Actions**. Adding packaging files to the source tree does not publish a live repository or create a signing key.

Verify the repository fingerprint against a trusted maintainer announcement before installing its key. Then run:

```bash
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://patrickbuhagiar24.github.io/youtube/archive-keyring.gpg \
  | sudo tee /etc/apt/keyrings/yt-unsub-detector.gpg > /dev/null
sudo chmod 0644 /etc/apt/keyrings/yt-unsub-detector.gpg
curl -fsSL https://patrickbuhagiar24.github.io/youtube/yt-unsub-detector.sources \
  | sudo tee /etc/apt/sources.list.d/yt-unsub-detector.sources > /dev/null
sudo apt update
sudo apt install yt-unsub-detector
```

That is the whole installation. The package registers the extension for Chrome/Chromium automatically. **Restart the browser** after APT finishes, then open <https://www.youtube.com> and sign in. There is no `Load unpacked` step and no separate per-user installer command.

The first APT installation creates a machine-local CRX signing key under `/var/lib/yt-unsub-detector` and uses it to pack/register the extension. Upgrades keep that key, so the extension ID and browser storage remain stable. Google Drive configuration is never stored inside the extension package.

### Upgrade

```bash
sudo apt update
sudo apt upgrade
```

Restart the browser after the upgrade. Your user configuration and browser extension storage are preserved.

### Remove

```bash
sudo apt remove yt-unsub-detector
```

Restart the browser so it notices the removed registration. User configuration under `~/.config/yt-unsub-detector` is left in place. `sudo apt purge yt-unsub-detector` also removes the machine-local CRX key; a later reinstall will create a new extension ID.

### Local package installation

If you have a built package instead of a published repository:

```bash
sudo apt install ./dist/yt-unsub-detector_1.21.0ubuntu1_all.deb
```

Restart the browser afterward.

## Per-user Google Drive configuration

Google Drive is disabled until both a file link and a valid service account key are provided. Configuration lives in the user's XDG configuration folder, outside the extension:

```text
~/.config/yt-unsub-detector/google-drive.json
~/.config/yt-unsub-detector/service-account.json
```

If `XDG_CONFIG_HOME` is set, the folder is `$XDG_CONFIG_HOME/yt-unsub-detector`. The extension creates private default files on first use. You can also create or locate them explicitly:

```bash
# Run as your normal desktop user, NOT with sudo.
yt-unsub-detector config
yt-unsub-detector status
```

1. Create a service account in Google Cloud and enable the Google Drive API.
2. Download its JSON key and save it as `service-account.json` in the user configuration folder.
3. Upload `YouTube.json` to **your own** Google Drive. Share that file with the service account's `client_email` as an **Editor**. A new service account cannot create files using its own storage quota.
4. Put the shared **file** link, not a folder link, into `google-drive.json`:

   ```json
   {
     "link": "https://drive.google.com/file/d/YOUR_FILE_ID/view"
   }
   ```

   `google-drive.json` may also contain a bare JSON string with the link. The service account key is always read from `service-account.json` beside it.
5. Restart the browser or click the extension's Google Drive sync button.

The extension reads these two files through an APT-installed native messaging host. The host manifest allows only this extension's ID, and the configuration files are created with private permissions (`0700` directory, `0600` files). An existing `drive-config.json` wrapper is migrated into these two files and removed automatically. Configuration from the older per-user extension directory is also migrated once, without overwriting newer user edits. The repository root contains a placeholder template only; the installed extension reads the per-user files, not the template.

**Keep service account keys private.** Never put a real key in a commit, issue, screenshot, or shared extension archive. The service account key is separate from the APT repository signing key and the machine-local CRX signing key.

### English data format

Drive files use `application`, `description`, `updatedAt`, `unsubscribeCount`, and channel fields `id`, `name`, `url`, `status`, and `date`. Status values are `unsubscribed` and `resubscribed`. Only this English format is read and written. Keep a backup of your Drive file before upgrading.

## Privacy and behavior

Subscription data is stored in browser extension storage. YouTube requests use your current browser session. If configured, unsubscribe history and channel names/URLs are sent to your Google Drive file using your service account. Sorting may automatically load additional YouTube results, up to the built-in limit. This project uses YouTube page internals that may change; refresh the page or list if detection stops working.

## Build and test

Build dependencies on Ubuntu 26.10:

```bash
sudo apt update
sudo apt install build-essential dpkg-dev nodejs python3 openssl make gzip xz-utils
make test
make package
make apt-repository
```

The binary package is written to `dist/`. `make apt-repository` creates **unsigned** staging metadata; it must be signed before publication. `make source-package` builds a source package. See [APT repository publishing](docs/PUBLISHING_APT.md) for signing, CI secrets, and deployment.

The CI workflow builds and tests inside an `ubuntu:26.10` container. Local builds on other Debian-based systems can check packaging, but are not a substitute for the target-release test.

## License

MIT. See [LICENSE](LICENSE).

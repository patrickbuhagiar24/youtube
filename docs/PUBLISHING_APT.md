# Publish the signed APT repository

This repository ships the infrastructure for an APT archive, not a pre-existing public package feed. Ubuntu 26.10 is `stonking`; the archive deliberately names that suite rather than pretending an architecture-independent package was built for every Ubuntu release. Canonical's release announcement confirms the 26.10 codename: <https://canonical.com/blog/canonical-releases-ubuntu-26-10-stonking-stingray>.

The included workflows target `ubuntu:26.10` and publish this layout through GitHub Pages:

```text
archive-keyring.asc
archive-keyring.gpg
archive-keyring.fingerprint.txt
yt-unsub-detector.sources
pool/main/y/yt-unsub-detector/yt-unsub-detector_<version>_all.deb
dists/stonking/Release
dists/stonking/InRelease
dists/stonking/Release.gpg
dists/stonking/main/binary-all/Packages
dists/stonking/main/binary-all/Packages.gz
```

## 1. Use the repository signing key

Use the existing dedicated APT signing key exported into `GPG_PRIVATE_KEY`. Do not reuse a personal encryption key, Google service account key, or TLS private key. If you ever need to create a replacement key, a signing-only RSA 4096-bit key with an expiration date is a conservative choice for APT clients:

```bash
gpg --full-generate-key
# Choose RSA and RSA, 4096 bits, an appropriate expiration, and a strong passphrase.
gpg --list-secret-keys --keyid-format long
```

Record the full 40-character fingerprint. Export the armored private key and public key into a protected directory outside the repository:

```bash
export FINGERPRINT=YOUR_FULL_40_CHARACTER_FINGERPRINT
umask 077
gpg --armor --export-secret-keys "$FINGERPRINT" > apt-signing.private.asc
gpg --armor --export "$FINGERPRINT" > apt-signing-public.asc
```

Keep an offline backup and plan for expiration/rotation. Never commit the private export. The repository ignores `*.private.asc`, but an ignore rule is not a substitute for careful handling.

## 2. Configure GitHub Actions and Pages

In the GitHub repository, open **Settings → Secrets and variables → Actions** and create these repository **Secrets** (not Variables):

| Secret | Value |
| --- | --- |
| `GPG_PRIVATE_KEY` | Full armored private key export, including the BEGIN/END lines; exactly one primary key identity, with its signing subkeys if present |
| `GPG_PASSPHRASE` | Key passphrase; an empty value is supported only for an unprotected key |

If these secrets already exist, reuse them; do not generate another key. No fingerprint secret is required: the workflow derives the primary fingerprint from the imported key and checks that a secret signing capability is available. The fingerprint is public metadata and is published as `archive-keyring.fingerprint.txt`.

### Enable GitHub Pages

GitHub Pages must be enabled once by a repository administrator; the publish workflow cannot create the site with the default `GITHUB_TOKEN`.

1. Open `https://github.com/patrickbuhagiar24/youtube/settings/pages`.
2. Under **Build and deployment**, set **Source** to **GitHub Actions** (not **Deploy from a branch**).
3. Save/confirm the selection. The expected URL is `https://patrickbuhagiar24.github.io/youtube/`.
4. Open **Settings → Environments → github-pages**. If **Deployment branches and tags** has protection rules, allow the `main` branch or choose **No restriction**. A deployment can otherwise be rejected even though the build succeeded.
5. A push to `main` automatically runs the publish workflow. Alternatively, run **Actions → Publish signed APT repository → Run workflow** and select `main`.

If you fork or rename the repository, update `packaging/yt-unsub-detector.sources`, `packaging/apt-index.html`, and the installation commands in `README.md` before publishing.

The publish workflow imports `GPG_PRIVATE_KEY` into an isolated, ephemeral CI keyring, uses `GPG_PASSPHRASE` only to unlock signing operations, signs `Release` into both `InRelease` and `Release.gpg`, verifies both signatures, exports only the public key, and removes the temporary keyring. It does not print the private key or upload it as a Pages artifact. Secret values cannot be read back through the GitHub API; they are available only to the workflow at runtime.

## 3. Build, review, and publish

Local checks:

```bash
sudo apt install build-essential dpkg-dev nodejs python3 openssl make gzip xz-utils gnupg gpgv
make test
make package
make source-package
make apt-repository
```

Do not publish `dist/apt` while it is unsigned. For a local signed test, import your dedicated key into a temporary `GNUPGHOME`, set `APT_SIGNING_KEY_ID` to its full primary fingerprint and `GPG_PASSPHRASE` to its passphrase, and run:

```bash
bash scripts/sign-apt-repository.sh dist/apt stonking
```

Commit and push the reviewed changes through your normal review process. A push to `main`, including a pull request merge, automatically builds, tests, signs, and deploys the APT archive to GitHub Pages. Version tags may still be used for releases, but they do not trigger this workflow. Alternatively, run **Publish signed APT repository** manually from the Actions tab and select `main`.

The workflow refuses to publish without signing secrets. Each publication replaces the archive with the packages from that build; it is not an accumulating mirror. Keep previous release artifacts elsewhere if rollback is required. Increment the Debian package version whenever package contents change: APT will not automatically upgrade an installed package to a different build with the same version.

Publish the full signing-key fingerprint through a trusted maintainer channel so users can verify `archive-keyring.fingerprint.txt` before trusting the downloaded key. HTTPS alone is not a substitute for APT signatures. Do not use `[trusted=yes]`, `--allow-unauthenticated`, or the deprecated global `apt-key` store.

## 4. Verify the live feed

From an Ubuntu 26.10 machine:

```bash
curl -fsI https://patrickbuhagiar24.github.io/youtube/dists/stonking/InRelease
curl -fsSL https://patrickbuhagiar24.github.io/youtube/archive-keyring.asc \
  | gpg --show-keys --with-fingerprint
sudo apt update
apt-cache policy yt-unsub-detector
sudo apt install yt-unsub-detector
```

Restart Chrome/Chromium after installation. The package registers the extension automatically; there is no `Load unpacked` step.

The source uses `Architectures: all` and `binary-all` indices because this package contains only JavaScript, HTML, CSS, icons, Python, and maintainer scripts. Test on the target browser as well: APT installation and JavaScript unit tests cannot prove live YouTube DOM compatibility.

The CRX signing key is machine-local, created under `/var/lib/yt-unsub-detector` on first installation. It is not a GitHub secret and is not published. It keeps the extension ID stable across APT upgrades on that machine. Google Drive configuration remains per user under `~/.config/yt-unsub-detector`.

## Upgrades and removal

Before merging changes to package contents, add a newer version to `debian/changelog`. Also bump `manifest.json` when the extension itself changes; its version must change for browser extension upgrades. APT upgrades rebuild the registered CRX with the same machine-local key. Users restart the browser; browser extension storage and user Drive configuration are preserved.

`apt remove` deletes the browser registration and native-host manifests. `apt purge` also deletes the machine-local CRX key, so a later reinstall creates a new extension ID. User configuration under `~/.config/yt-unsub-detector` is not removed by either command.

## Troubleshooting

- **404 for `InRelease`:** Pages has not been published yet, or the workflow failed. Check Actions and confirm **Settings → Pages → Source** is **GitHub Actions**.
- **Pages deployment rejected for `main`:** check **Settings → Environments → github-pages → Deployment branches and tags** and allow the `main` branch.
- **Missing public key / unsigned repository:** configure the signing secrets and rerun publication. Never work around this by disabling verification.
- **Wrong suite:** Ubuntu 26.10 must use `stonking`, not `26.10`, `stable`, or another Ubuntu codename.
- **Package installed but no browser toolbar icon:** restart Chrome/Chromium. This packaging supports `.deb` browser installs, not Snap/Flatpak builds.
- **Old version after APT upgrade:** restart the browser so it rescans the external-extension registration.
- **Drive is not configured:** run `yt-unsub-detector config` as the desktop user and edit the printed `google-drive.json` and `service-account.json` paths.

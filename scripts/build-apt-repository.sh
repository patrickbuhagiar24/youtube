#!/usr/bin/env bash
# Build a small, standard APT archive containing architecture-independent packages.
set -euo pipefail
export LC_ALL=C

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 PACKAGE_DIRECTORY OUTPUT_DIRECTORY [SUITE]" >&2
  exit 2
fi
package_dir=$(realpath -m "$1")
output_dir=$(realpath -m "$2")
suite=${3:-stonking}
if [[ ! "$suite" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo 'Invalid APT suite name.' >&2
  exit 2
fi
if [[ "$output_dir" == "$package_dir" || "$output_dir" == "$package_dir"/* ]]; then
  echo 'The repository output must be outside the input package directory.' >&2
  exit 2
fi
command -v dpkg-scanpackages >/dev/null || { echo 'Install dpkg-dev first.' >&2; exit 1; }
shopt -s nullglob
packages=("$package_dir"/*.deb)
if [[ ${#packages[@]} -eq 0 ]]; then
  echo "No .deb files found in $package_dir" >&2
  exit 1
fi
for package in "${packages[@]}"; do
  architecture=$(dpkg-deb --field "$package" Architecture)
  [[ "$architecture" == all ]] || { echo "Only Architecture: all packages are supported: $package" >&2; exit 1; }
done

staging=$(mktemp -d "${TMPDIR:-/tmp}/ytuc-apt.XXXXXX")
trap 'rm -rf "$staging"' EXIT
pool="$staging/pool/main/y/yt-unsub-detector"
dist="$staging/dists/$suite"
mkdir -p "$pool" "$dist/main/binary-all"
cp "${packages[@]}" "$pool/"
chmod 0644 "$pool"/*.deb
# Supply the archive override entries from each package's own control fields.
: > "$staging/override"
for package in "${packages[@]}"; do
  name=$(dpkg-deb --field "$package" Package)
  priority=$(dpkg-deb --field "$package" Priority)
  section=$(dpkg-deb --field "$package" Section)
  printf '%s %s %s\n' "$name" "${priority:-optional}" "${section:-misc}" >> "$staging/override"
done
(
  cd "$staging"
  dpkg-scanpackages --multiversion pool override > "dists/$suite/main/binary-all/Packages"
)
gzip -n -9 -c "$dist/main/binary-all/Packages" > "$dist/main/binary-all/Packages.gz"
python3 "$(dirname "$0")/write-apt-release.py" "$dist" "$suite"

install -m 0644 "$(dirname "$0")/../packaging/yt-unsub-detector.sources" "$staging/yt-unsub-detector.sources"
install -m 0644 "$(dirname "$0")/../packaging/apt-index.html" "$staging/index.html"
touch "$staging/.nojekyll"
# Replace only our generated output; never delete an unrelated user directory.
mkdir -p "$output_dir"
if [[ -e "$output_dir/dists" || -e "$output_dir/pool" ]]; then
  echo "Output already contains an archive: $output_dir. Use a fresh output directory." >&2
  exit 1
fi
cp -a "$staging"/. "$output_dir"/
echo "Unsigned APT archive created at $output_dir (suite: $suite, architecture: all)."

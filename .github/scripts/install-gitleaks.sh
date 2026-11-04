#!/usr/bin/env bash
set -euo pipefail
version=8.30.1
directory=$(mktemp -d)
trap 'rm -rf "$directory"' EXIT
gh release download "v$version" --repo gitleaks/gitleaks \
  --pattern "gitleaks_${version}_linux_x64.tar.gz" \
  --pattern "gitleaks_${version}_checksums.txt" --dir "$directory"
(
  cd "$directory"
  grep " gitleaks_${version}_linux_x64.tar.gz$" "gitleaks_${version}_checksums.txt" > checksum.txt
  test "$(wc -l < checksum.txt)" -eq 1
  sha256sum --check checksum.txt
  tar -xzf "gitleaks_${version}_linux_x64.tar.gz" gitleaks
)
install_directory="${RUNNER_TEMP:-$HOME/.local}/gitleaks-bin"
mkdir -p "$install_directory"
install -m 755 "$directory/gitleaks" "$install_directory/gitleaks"
if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "$install_directory" >> "$GITHUB_PATH"
else
  printf 'Installed Gitleaks at %s/gitleaks\n' "$install_directory"
fi

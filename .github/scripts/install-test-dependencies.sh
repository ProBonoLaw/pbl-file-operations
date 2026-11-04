#!/usr/bin/env bash
set -euo pipefail

# Only downloads are interrupted by timeout; dpkg is not started until every
# archive is available, so switching mirrors cannot interrupt configuration.
packages=(
  libreoffice-writer libreoffice-impress libreoffice-calc poppler-utils qpdf
  fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea
)
apt_options=(
  -o Acquire::http::Timeout=20
  -o Acquire::https::Timeout=20
  -o Acquire::Retries=1
  -o Acquire::Languages=none
  -o DPkg::Lock::Timeout=60
)
source_options=()
fallback_directory=''
trap 'if [[ -n "$fallback_directory" ]]; then rm -rf "$fallback_directory"; fi' EXIT

download_packages() {
  sudo timeout --kill-after=10s 60s apt-get "${apt_options[@]}" "${source_options[@]}" \
    -o APT::Update::Error-Mode=any update &&
  sudo timeout --kill-after=10s 180s apt-get "${apt_options[@]}" "${source_options[@]}" \
    install --yes --no-install-recommends --download-only "${packages[@]}"
}

echo 'Downloading native test dependencies from the runner package sources'
if ! download_packages; then
  echo '::warning::Package download failed or timed out; retrying with the official Ubuntu HTTPS mirrors'
  # GitHub-hosted test jobs use Ubuntu 24.04 amd64. Do not rewrite the runner's
  # source files or include unrelated third-party repositories in the fallback.
  . /etc/os-release
  if [[ "$ID" != ubuntu || "${VERSION_CODENAME:-}" != noble || "$(dpkg --print-architecture)" != amd64 ]]; then
    echo 'The test dependency fallback requires Ubuntu 24.04 amd64' >&2
    exit 1
  fi
  fallback_directory=$(mktemp -d "${RUNNER_TEMP:-/tmp}/file-operations-apt.XXXXXX")
  chmod 755 "$fallback_directory"
  cat > "$fallback_directory/ubuntu.list" <<'SOURCES'
deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu noble main universe restricted multiverse
deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu noble-updates main universe restricted multiverse
deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu noble-backports main universe restricted multiverse
deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://security.ubuntu.com/ubuntu noble-security main universe restricted multiverse
SOURCES
  source_options=(-o "Dir::Etc::sourcelist=$fallback_directory/ubuntu.list" -o Dir::Etc::sourceparts=-)
  if ! download_packages; then
    echo '::error::Could not download native test dependencies from either source; tests have not started'
    exit 1
  fi
fi

echo 'Installing downloaded native test dependencies'
sudo env DEBIAN_FRONTEND=noninteractive apt-get "${apt_options[@]}" "${source_options[@]}" \
  install --yes --no-install-recommends --no-download "${packages[@]}"

#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "$0")/../.." && pwd)
dependency_test_directory=$(mktemp -d)
trap 'rm -rf "$dependency_test_directory"' EXIT
mkdir -p "$dependency_test_directory/bin" "$dependency_test_directory/temp"

# Never install host packages in this test. Simulate downloader failures and
# verify that installation only happens after a successful bounded download.
cat > "$dependency_test_directory/bin/sudo" <<'MOCK'
#!/usr/bin/env bash
exec "$@"
MOCK
cat > "$dependency_test_directory/bin/timeout" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == --kill-after=10s && "$2" =~ ^(60|180)s$ ]]
printf 'timeout %s\n' "$2" >> "$DEPENDENCY_TEST_LOG"
shift 2
exec "$@"
MOCK
cat > "$dependency_test_directory/bin/dpkg" <<'MOCK'
#!/usr/bin/env bash
[[ "$1" == --print-architecture ]] || exit 1
echo amd64
MOCK
cat > "$dependency_test_directory/bin/apt-get" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == *'Acquire::http::Timeout=20'* && "$*" == *'Acquire::https::Timeout=20'* ]]
[[ "$*" == *'Acquire::Retries=1'* && "$*" == *'DPkg::Lock::Timeout=60'* ]]
source_name=runner
for argument in "$@"; do
  if [[ "$argument" == Dir::Etc::sourcelist=* ]]; then
    source_name=fallback
    source_file=${argument#*=}
    [[ "$*" == *'Dir::Etc::sourceparts=-'* ]]
    grep -q 'signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg' "$source_file"
    grep -q 'https://archive.ubuntu.com/ubuntu noble ' "$source_file"
    grep -q 'https://security.ubuntu.com/ubuntu noble-security ' "$source_file"
    cp "$source_file" "$DEPENDENCY_TEST_SOURCES"
  fi
done
if [[ " $* " == *' update '* ]]; then
  operation=update
  [[ "$*" == *'APT::Update::Error-Mode=any'* ]]
elif [[ " $* " == *' --download-only '* ]]; then
  operation=download
elif [[ " $* " == *' --no-download '* ]]; then
  operation=install
  [[ "${DEBIAN_FRONTEND:-}" == noninteractive ]]
else
  echo 'Unexpected package operation' >&2
  exit 1
fi
printf '%s %s\n' "$source_name" "$operation" >> "$DEPENDENCY_TEST_LOG"
case "$DEPENDENCY_TEST_SCENARIO:$source_name:$operation" in
  download-timeout:runner:download) exit 124 ;;
  update-failure:runner:update|both-fail:*:download|install-failure:*:install) exit 100 ;;
esac
MOCK
chmod +x "$dependency_test_directory/bin/"*
export PATH="$dependency_test_directory/bin:$PATH"
export RUNNER_TEMP="$dependency_test_directory/temp"
export DEPENDENCY_TEST_LOG="$dependency_test_directory/commands.log"
export DEPENDENCY_TEST_SOURCES="$dependency_test_directory/sources.list"

assert_no_command() {
  if grep -q -- "$1" "$DEPENDENCY_TEST_LOG"; then
    echo "FAIL: unexpected command matching '$1'" >&2
    cat "$DEPENDENCY_TEST_LOG" >&2
    exit 1
  fi
}

for scenario in success download-timeout update-failure both-fail install-failure; do
  export DEPENDENCY_TEST_SCENARIO="$scenario"
  : > "$DEPENDENCY_TEST_LOG"
  status=0
  bash "$repository_root/.github/scripts/install-test-dependencies.sh" > "$dependency_test_directory/output.log" 2>&1 || status=$?
  if [[ "$scenario" == both-fail || "$scenario" == install-failure ]]; then
    [[ "$status" -ne 0 ]]
  else
    [[ "$status" == 0 ]]
  fi
  case "$scenario" in
    success)
      [[ "$(grep -c '^runner ' "$DEPENDENCY_TEST_LOG")" == 3 ]]
      assert_no_command '^fallback ' ;;
    download-timeout|update-failure)
      [[ "$(grep -c '^fallback ' "$DEPENDENCY_TEST_LOG")" == 3 ]]
      [[ "$(tail -1 "$DEPENDENCY_TEST_LOG")" == 'fallback install' ]]
      assert_no_command '^runner install$' ;;
    both-fail)
      assert_no_command ' install$'
      grep -q 'tests have not started' "$dependency_test_directory/output.log" ;;
    install-failure)
      assert_no_command '^fallback ' ;;
  esac
  # The temporary fallback source file must always be cleaned up.
  [[ -z "$(find "$RUNNER_TEMP" -mindepth 1 -print -quit)" ]]
  echo "PASS: $scenario"
done

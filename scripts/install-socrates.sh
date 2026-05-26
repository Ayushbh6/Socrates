#!/usr/bin/env bash
set -euo pipefail

REPO="${SOCRATES_RELEASE_REPO:-Ayushbh6/Socrates}"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

OS="$(uname -s)"
ARCH="$(uname -m)"
if [[ "${OS}" != "Darwin" ]]; then
  echo "This installer is for macOS. Use install-socrates.ps1 on Windows." >&2
  exit 1
fi
if [[ "${ARCH}" != "arm64" ]]; then
  echo "This first Socrates installer supports Apple Silicon macOS only." >&2
  exit 1
fi

python3 - "$API_URL" "$TMP_DIR/release.json" <<'PY'
import json, sys, urllib.request
url, target = sys.argv[1], sys.argv[2]
with urllib.request.urlopen(url) as response:
    data = response.read()
open(target, "wb").write(data)
PY

ASSET_URL="$(python3 - "$TMP_DIR/release.json" <<'PY'
import json, sys
release = json.load(open(sys.argv[1]))
for asset in release.get("assets", []):
    name = asset.get("name", "")
    if name.endswith("_aarch64.dmg"):
        print(asset["browser_download_url"])
        break
else:
    raise SystemExit("No Apple Silicon DMG asset found in the latest release.")
PY
)"
SUMS_URL="$(python3 - "$TMP_DIR/release.json" <<'PY'
import json, sys
release = json.load(open(sys.argv[1]))
for asset in release.get("assets", []):
    if asset.get("name") == "SHA256SUMS":
        print(asset["browser_download_url"])
        break
else:
    raise SystemExit("No SHA256SUMS asset found in the latest release.")
PY
)"

DMG_PATH="${TMP_DIR}/$(basename "${ASSET_URL}")"
curl -fL "${ASSET_URL}" -o "${DMG_PATH}"
curl -fL "${SUMS_URL}" -o "${TMP_DIR}/SHA256SUMS"

EXPECTED="$(grep " $(basename "${DMG_PATH}")$" "${TMP_DIR}/SHA256SUMS" | awk '{print $1}')"
ACTUAL="$(shasum -a 256 "${DMG_PATH}" | awk '{print $1}')"
if [[ -z "${EXPECTED}" || "${EXPECTED}" != "${ACTUAL}" ]]; then
  echo "Checksum verification failed for ${DMG_PATH}" >&2
  exit 1
fi

echo "Downloaded and verified ${DMG_PATH}"
echo "Opening the Socrates installer..."
open "${DMG_PATH}"

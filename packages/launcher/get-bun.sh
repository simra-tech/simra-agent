#!/bin/sh
# Download the pinned Bun for this machine to <dir>/bun, and stop if its hash is wrong. The hashes are from the
# SHASUMS256.txt of the Bun release. x64 gets the baseline build, which does not need AVX2 (as pi's binary).
#
#   sh packages/launcher/get-bun.sh <dir>
set -eu
version=1.4.4
case "$(uname -s)-$(uname -m)" in
Linux-x86_64) asset=bun-linux-x64-baseline sha=e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76 ;;
Linux-aarch64 | Linux-arm64) asset=bun-linux-aarch64 sha=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e ;;
Darwin-x86_64) asset=bun-darwin-x64-baseline sha=d4a155adfbfd09155eb3ba05c9e3a544f39297d7a68616d3c7759f67ab5c47dc ;;
Darwin-arm64) asset=bun-darwin-aarch64 sha=c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510 ;;
*) echo "get-bun.sh: no Bun for $(uname -s)-$(uname -m)" >&2 && exit 1 ;;
esac
mkdir -p "$1"
curl -fsSL -o "$1/$asset.zip" "https://github.com/oven-sh/bun/releases/download/bun-v$version/$asset.zip"
if command -v sha256sum >/dev/null; then sum=$(sha256sum "$1/$asset.zip"); else sum=$(shasum -a 256 "$1/$asset.zip"); fi
if [ "${sum%% *}" != "$sha" ]; then echo "get-bun.sh: $asset.zip has the wrong hash" >&2 && exit 1; fi
unzip -q -o "$1/$asset.zip" -d "$1"
mv "$1/$asset/bun" "$1/bun"
"$1/bun" --version

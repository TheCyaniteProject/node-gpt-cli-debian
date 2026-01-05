#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target_dir="$(cd "$script_dir/.." && pwd)"
cd "$target_dir"

url="https://raw.githubusercontent.com/TheCyaniteProject/debian-automations/main/sub/gpt-install.sh"

tmp="$(mktemp --suffix=.sh 2>/dev/null || mktemp -t gpt-install.sh)"
trap 'rm -f "$tmp"' EXIT

if ! curl -fsSL "$url" -o "$tmp"; then
    echo "Error: failed to download $url" >&2
    exit 1
fi

chmod +x "$tmp"
bash "$tmp" "$@"
#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"

if command -v npm >/dev/null 2>&1; then
    echo "Running npm install in $project_dir"
    (cd "$project_dir" && npm install --no-audit --no-fund)
else
    echo "npm not found; skipping npm install" >&2
fi

cli_dir="$(cd "$script_dir/../cli" 2>/dev/null && pwd || true)"

if [ -z "$cli_dir" ] || [ ! -d "$cli_dir" ]; then
    echo "CLI directory not found: $script_dir/../cli" >&2
    exit 1
fi

# Ensure POSIX shim is executable
if [ -f "$cli_dir/gpt" ] && [ ! -x "$cli_dir/gpt" ]; then
    chmod +x "$cli_dir/gpt"
    echo "Marked $cli_dir/gpt as executable"
fi

export_line="export PATH=\"$cli_dir:\$PATH\""

if [ "$(id -u)" -eq 0 ]; then
    target="/etc/profile.d/node-gpt-cli.sh"
    # Ensure target exists and add PATH line if missing
    touch "$target"
    if grep -F -- "$cli_dir" "$target" >/dev/null 2>&1; then
        echo "Path already present in $target"
    else
        printf "%s\n" "$export_line" >> "$target"
        echo "Appended PATH export to $target"
    fi
    chmod 644 "$target"
else
    if [ -f "$HOME/.profile" ]; then
        target="$HOME/.profile"
    else
        target="$HOME/.bash_profile"
    fi

    if grep -F -- "$cli_dir" "$target" >/dev/null 2>&1; then
        echo "Path already present in $target"
    else
        printf "\n# Add node-gpt-cli\n%s\n" "$export_line" >> "$target"
        echo "Appended PATH export to $target"
    fi
fi

# Optionally set OPENAI_API_KEY permanently
# Controls:
#   - First argument "-y" or env SKIP_API_PROMPT=1: skip prompting entirely
if [ "${1:-}" = "-y" ] || [ "${SKIP_API_PROMPT:-0}" = "1" ]; then
    echo "Skipping OPENAI_API_KEY prompt (-y/SKIP_API_PROMPT provided)"
else
    echo
    prompt_msg="Enter OPENAI_API_KEY (leave blank or type -y to skip): "

    # Prefer the controlling TTY so this works even when stdin is a pipe (e.g., wget ... | bash)
    if [ -r "/dev/tty" ] && [ -w "/dev/tty" ]; then
        printf "%s" "$prompt_msg" > /dev/tty
        IFS= read -r OPENAI_API_KEY_INPUT < /dev/tty || OPENAI_API_KEY_INPUT=""
    elif [ -t 0 ]; then
        printf "%s" "$prompt_msg"
        IFS= read -r OPENAI_API_KEY_INPUT || OPENAI_API_KEY_INPUT=""
    else
        echo "No interactive terminal available; skipping OPENAI_API_KEY configuration (pass -y to skip or set OPENAI_API_KEY environment)" >&2
        OPENAI_API_KEY_INPUT=""
    fi

    if [ -n "${OPENAI_API_KEY_INPUT:-}" ] && [ "${OPENAI_API_KEY_INPUT}" != "-y" ]; then
        # Sanitize single quotes for safe single-quoted export
        sanitized_key=$(printf "%s" "$OPENAI_API_KEY_INPUT" | sed "s/'/'\"'\"'/g")
        key_line="export OPENAI_API_KEY='${sanitized_key}'"

        # Ensure target is set from the PATH section above; then write/update key there
        if [ -z "${target:-}" ]; then
            # Fallback selection (should not happen, but be safe)
            if [ "$(id -u)" -eq 0 ]; then
                target="/etc/profile.d/node-gpt-cli.sh"
            else
                if [ -f "$HOME/.profile" ]; then
                    target="$HOME/.profile"
                else
                    target="$HOME/.bash_profile"
                fi
            fi
        fi

        # Make sure the file exists before editing/appending
        touch "$target"

        if grep -q '^export OPENAI_API_KEY=' "$target" >/dev/null 2>&1; then
            # Replace existing definition
            sed -i "s|^export OPENAI_API_KEY=.*$|${key_line}|" "$target"
            echo "Updated OPENAI_API_KEY in $target"
        else
            printf "\n# OpenAI API key for node-gpt-cli\n%s\n" "$key_line" >> "$target"
            echo "Added OPENAI_API_KEY to $target"
        fi

        # Ensure readable permissions for profile.d when root
        if [ "$(id -u)" -eq 0 ] && [ "$target" = "/etc/profile.d/node-gpt-cli.sh" ]; then
            chmod 644 "$target"
        fi
    else
        echo "Skipping OPENAI_API_KEY configuration"
    fi
fi
# node-gpt-cli-debian

Simple OpenAI ChatGPT CLI in Node.js for Debian, Windows, and WSL.

- Core script: [gpt.js](gpt.js)
- CLI shims: [cli/gpt](cli/gpt), [cli/gpt.cmd](cli/gpt.cmd)
- Installers: [installer/install.sh](installer/install.sh), [installer/install.cmd](installer/install.cmd)

## Features

- One-shot prompts or interactive REPL
- File input (`--in`) and file output (`--out`)
- Session history persisted to JSON (`--session`), auto-detected `.gptp` files in CWD
- Optional system role (`--role`) and dev-mode output (`--dev`)
- Streaming tokens by default (disable with `--no-stream`)
- Model/temperature/max-tokens controls

Backed by the official OpenAI SDK via the chat completions API in [gpt.js](gpt.js).

## Requirements

- Node.js 18+ and npm
- An OpenAI API key available as the `OPENAI_API_KEY` environment variable

## Auto-install on Debian/Ubuntu/WSL

Auto-install prerequisites and this CLI in one step using either command:

```
wget -qO- https://raw.githubusercontent.com/TheCyaniteProject/debian-automations/main/full-install.sh | bash
```

or

```
curl -fsSL https://raw.githubusercontent.com/TheCyaniteProject/debian-automations/main/full-install.sh | bash
```

## Install on Debian (terminal)

1) Install Node.js (recommended: NodeSource repo)

```
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

2) Run the installer from the project directory

```
cd node-gpt-cli-debian
chmod +x installer/install.sh
./installer/install.sh
```

What the installer does:
- Runs `npm install` in the project root
- Adds the `cli` directory to your PATH (system-wide via `/etc/profile.d` if run with sudo; otherwise in your shell profile)
- Optionally saves `OPENAI_API_KEY` to your profile

3) Reload your shell

```
exec "$SHELL"
```

Now `gpt` should be available in your PATH.

## Install on Windows (Command Prompt or PowerShell)

Requirements:
- Node.js 18+ for Windows

Steps:

```
cd node-gpt-cli-debian
installer\install.cmd
```

What the installer does:
- Runs npm install in the project root
- Adds the `cli` directory to your user PATH via `setx` (no admin needed)
- Optionally saves `OPENAI_API_KEY` to your user environment

Notes:
- Open a NEW terminal window after installation so the updated PATH and variables apply.
- Test with: `gpt --interactive`

To skip the API key prompt:

```
installer\install.cmd -y
```

If you prefer manual PATH setup, add the absolute path to the `cli` folder to your user PATH.

## Install on WSL (Ubuntu/Debian)

Run the Linux installer inside WSL. This makes `gpt` available in your WSL shell.

```
cd node-gpt-cli-debian
chmod +x installer/install.sh
./installer/install.sh
exec "$SHELL"
```

API key in WSL:
- Set it in WSL just like Linux: `export OPENAI_API_KEY="sk-..."` and persist in `~/.profile`.
- Windows environment variables are not automatically imported into WSL shells. If your key is set in Windows, copy it into WSL and export it there.

## Configure your API key

You can set it during installation, or later:

```
export OPENAI_API_KEY="sk-..."
```

To persist it:
- Add the export line to `~/.profile` (or `~/.bash_profile`), or rerun the installer to append it for you.

## Quick start

One-shot prompt:

```
gpt "Write a haiku about Debian"
```

Interactive REPL:

```
gpt --interactive
```

With a system role and session file:

```
gpt --role "You are a helpful CLI assistant." --session myproj "Summarize src"
```

## Usage

All options are implemented in [gpt.js](gpt.js):

```
gpt [prompt]

Options:
  -i, --in <filepath>         Input file to prepend to the prompt
  -o, --out <filepath>        Write the assistant reply to a file (also prints unless --quiet)
  -r, --role <message>        Add a system message before the first user prompt
  -d, --dev                   Developer mode: ask for code-only output; strips code fences
  -m, --model <id>            Model ID (default: gpt-4.1-mini)
  -t, --temperature <number>  Sampling temperature (0–2)
      --max-tokens <number>   Maximum output tokens
  -q, --quiet                 Do not print response to stdout
  -s, --session <project>     Persist chat history to <project>.gptp (JSON). Auto-detects a single .gptp in CWD
  -I, --interactive           Start interactive chat REPL
      --no-stream             Disable streaming (non-streaming by default when --dev)
```

Notes:
- Streaming is on by default, except when `--dev` is used (to keep outputs clean for scripting).
- If `--session` is omitted, the CLI will auto-load the most recent `.gptp` file in the current directory if exactly one exists.

## Examples

- Pipe a file into the prompt context and save the answer:

```
gpt -i README.md -o answer.txt "Extract the key points"
```

- Non-streaming with specific model and temperature:

```
gpt --no-stream -m gpt-4.1-mini -t 0.2 "Write a release note"
```

- Interactive session with persistent history:

```
gpt -I -s demo
```

## How it works

The CLI wraps the OpenAI SDK (see [package.json](package.json)) and calls the Chat Completions API, building `messages` from your inputs and any prior session history. See the main logic in [gpt.js](gpt.js).

Entry points:
- POSIX shell shim: [cli/gpt](cli/gpt)
- Windows shim: [cli/gpt.cmd](cli/gpt.cmd)

Installers:
- Debian/Linux: [installer/install.sh](installer/install.sh) (adds `cli` to PATH and optionally configures `OPENAI_API_KEY`)
- Windows: [installer/install.cmd](installer/install.cmd)

## Troubleshooting

- Command not found: ensure your shell has reloaded after installation (`exec "$SHELL"`), and confirm `which gpt` points to the repo's `cli/gpt`.
- Auth errors: confirm `OPENAI_API_KEY` is exported in the current shell: `env | grep OPENAI_API_KEY`.
- Old Node.js: ensure Node 18+ (`node -v`).
- Windows PATH not updated: open a NEW Command Prompt/PowerShell window after running `installer\\install.cmd`. Verify with `where gpt`.
- WSL cannot see Windows variables: export `OPENAI_API_KEY` inside WSL and persist in `~/.profile`.

## License

ISC (see `package.json`).

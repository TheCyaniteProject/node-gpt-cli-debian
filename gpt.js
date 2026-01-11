#! /usr/bin/env node
import { Command } from "commander";
import { OpenAI } from "openai";
import fs from "fs";
import readline from "readline";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const program = new Command();
const client = new OpenAI();

// Configuration helpers for default model persistence
function getConfigDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "gpt-cli");
}

function getConfigPath() {
  return path.join(getConfigDir(), "config.json");
}

function readConfig() {
  try {
    const p = getConfigPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  } catch (_) {}
  return {};
}

function writeConfig(cfg) {
  try {
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2));
    return true;
  } catch (e) {
    console.error("Failed to write config:", e?.message || e);
    return false;
  }
}

function getDefaultModel() {
  const cfg = readConfig();
  return cfg.defaultModel || "gpt-4.1-mini";
}

program
  .name('gpt')
  .description('Simple ChatGPT CLI')
  .argument('[prompt]', 'GPT prompt. If omitted, starts interactive mode.')
  .option('-i, --in <filepath>', 'Input file passed with prompt')
  .option('-o, --out <filepath>', 'Response output (will still print)')
  .option('-r, --role <message>', 'Add system message before the prompt')
  .option('-d, --dev', 'Append prompt with dev rules for output')
  .option('-m, --model <id>', 'The model to prompt', getDefaultModel())
  .option('--set-default-model <id>', 'Set and save the default model, then exit')
  .option('-t, --temperature <number>', 'Sampling temperature (0-2)', (v) => parseFloat(v))
  .option('--max-tokens <number>', 'Max output tokens', (v) => parseInt(v, 10))
  .option('-q, --quiet', 'Will not print response')
  .option('-s, --session <project>', 'Save/load chat history to project file')
  .option('-I, --interactive', 'Start interactive chat REPL')
  .option('--update', 'Run ./installer/update.sh and exit')
  .option('--no-stream', 'Disable streaming output')
  .parse();

const prompt = program.args[0];
const options = program.opts();

let fileData = "";
if (options.in) {
  try {
    fileData = fs.readFileSync(options.in, 'utf8');
  } catch (e) {
    console.log(e);
    process.exit(1);
  }
}

let chatHistory = [];
let todoList = [];
let debugEnabled = false;
let logging = { enabled: false, file: path.join(process.cwd(), 'gpt-tools.log') };
let diffPreview = { enabled: true, thresholdLines: 0, maxLines: 400 };

// Resolve project directory from current file location
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function runUpdateAndExit() {
  const scriptPath = path.join(__dirname, 'installer', 'update.sh');
  if (!fs.existsSync(scriptPath)) {
    console.error(`Update script not found at ${scriptPath}`);
    process.exit(1);
  }

  const shell = process.platform === 'win32' ? 'bash' : 'bash';
  const proc = spawn(shell, [scriptPath], { cwd: __dirname, stdio: 'inherit' });
  proc.on('error', (err) => {
    console.error(`Failed to launch update script: ${err?.message || err}`);
    process.exit(1);
  });
  proc.on('close', (code) => {
    process.exit(code ?? 0);
  });
}

// Determine session file: enforce .gptp extension and auto-detect in CWD
function ensureGptpExt(name) {
  return name.endsWith('.gptp') ? name : name + '.gptp';
}

function findCwdSessionFile() {
  try {
    const files = fs.readdirSync(process.cwd()).filter(f => f.toLowerCase().endsWith('.gptp'));
    if (files.length === 1) return files[0];
    if (files.length > 1) {
      // pick most recently modified
      const withTimes = files.map(f => ({ f, t: fs.statSync(path.join(process.cwd(), f)).mtimeMs }));
      withTimes.sort((a, b) => b.t - a.t);
      return withTimes[0].f;
    }
  } catch (_) {}
  return undefined;
}

let sessionFile = undefined;
if (options.session) {
  sessionFile = ensureGptpExt(options.session);
} else {
  const auto = findCwdSessionFile();
  if (auto) sessionFile = auto;
}

if (sessionFile && fs.existsSync(sessionFile)) {
  try {
    const data = fs.readFileSync(sessionFile, 'utf8');
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      // Legacy format: array = chatHistory only
      chatHistory = parsed;
    } else if (parsed && typeof parsed === 'object') {
      chatHistory = Array.isArray(parsed.chatHistory) ? parsed.chatHistory : [];
      todoList = Array.isArray(parsed.todoList) ? parsed.todoList : [];
      if (parsed.diffPreview && typeof parsed.diffPreview === 'object') {
        // Merge to preserve new defaults if older session lacks fields
        diffPreview = {
          enabled: typeof parsed.diffPreview.enabled === 'boolean' ? parsed.diffPreview.enabled : diffPreview.enabled,
          thresholdLines: Number.isInteger(parsed.diffPreview.thresholdLines) ? parsed.diffPreview.thresholdLines : diffPreview.thresholdLines,
          maxLines: Number.isInteger(parsed.diffPreview.maxLines) ? parsed.diffPreview.maxLines : diffPreview.maxLines,
        };
      }
    }
  } catch (e) {
    // If error reading session, start fresh
    chatHistory = [];
    todoList = [];
  }
}

async function saveSession() {
  if (sessionFile) {
    const payload = { chatHistory, todoList, diffPreview };
    fs.writeFileSync(sessionFile, JSON.stringify(payload, null, 2));
  }
}

function buildUserContent(text) {
  return (options.in ? fileData + "\n" : "") + text + (options.dev ? "\nDon't respond with anything other than code. Don't include any markdown." : "");
}

function toChatMessages() {
  // Preserve tool call metadata for Chat Completions API
  return chatHistory.map((m) => {
    const base = { role: m.role, content: m.content };
    if (m.role === 'assistant' && m.tool_calls) {
      base.tool_calls = m.tool_calls;
    }
    if (m.role === 'tool' && m.tool_call_id) {
      base.tool_call_id = m.tool_call_id;
    }
    return base;
  });
}

async function chatOnce(userInput) {
  if (options.role && !chatHistory.some(m => m.role === 'system')) {
    chatHistory.push({ role: 'system', content: options.role });
  }

  // Add the prompt to chat history
  chatHistory.push({ role: 'user', content: buildUserContent(userInput) });

  try {
    const messages = toChatMessages();

    const streamingEnabled = options.stream && !options.dev; // disable streaming when dev mode to allow clean output
    if (streamingEnabled) {
      // Stream tokens as they arrive
      const stream = await client.chat.completions.create({
        model: options.model,
        messages,
        temperature: typeof options.temperature === 'number' && !Number.isNaN(options.temperature) ? options.temperature : undefined,
        max_tokens: typeof options.maxTokens === 'number' && !Number.isNaN(options.maxTokens) ? options.maxTokens : undefined,
        stream: true,
      });

      let reply = '';
      for await (const part of stream) {
        const delta = part.choices?.[0]?.delta?.content || '';
        reply += delta;
        if (!options.quiet && delta) process.stdout.write(delta);
      }
      if (!options.quiet) process.stdout.write('\n');

      // Save the assistant's reply to chat history
      chatHistory.push({ role: 'assistant', content: reply.trim() });
      await saveSession();
      if (options.out) fs.writeFileSync(options.out, reply.trim());
    } else {
      // Non-streaming path
      const completion = await client.chat.completions.create({
        model: options.model,
        messages,
        temperature: typeof options.temperature === 'number' && !Number.isNaN(options.temperature) ? options.temperature : undefined,
        max_tokens: typeof options.maxTokens === 'number' && !Number.isNaN(options.maxTokens) ? options.maxTokens : undefined,
      });
      let reply = (completion.choices?.[0]?.message?.content || '').trim();

      // If dev mode, strip code fences for script-friendly output
      if (options.dev) {
        reply = reply
          .replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '')
          .replace(/\n?```$/, '');
      }

      if (!options.quiet) console.log(reply);
      chatHistory.push({ role: 'assistant', content: reply });
      await saveSession();
      if (options.out) fs.writeFileSync(options.out, reply);
    }
  } catch (err) {
    console.error('Error:', err?.message || err);
    process.exitCode = 1;
  }
}

async function startInteractive() {
  if (options.role) {
    // Ensure the system prompt is present once at the start of the session
    chatHistory.push({ role: 'system', content: options.role });
  }

  function pathCompleter(fragment) {
    try {
      const base = fragment.endsWith('/') ? fragment : path.dirname(fragment);
      const dir = base === '.' || base === '' || base === '/' ? process.cwd() : path.resolve(process.cwd(), base);
      const prefix = fragment.endsWith('/') ? '' : path.basename(fragment);
      const entries = fs.readdirSync(dir, { withFileTypes: true }).map(e => e.name + (e.isDirectory() ? '/' : ''));
      return entries
        .filter(name => name.toLowerCase().startsWith(prefix.toLowerCase()))
        .map(name => (base && base !== '.' && base !== '/' ? path.join(base, name) : name));
    } catch (_) {
      return [];
    }
  }

  function completer(line) {
    const commands = [
      '/help','/exit','/save','/todo','/perms','/log','/debug','/model','/retry','/edit','/reset','/restart','/clear','/diff'
    ];
    const todoSubs = ['list','add','update','complete','delete'];
    const permsSubs = ['list','clear'];
    const logSubs = ['on','off','set'];
    const debugSubs = ['on','off'];
    const modelSubs = ['set','temp','maxtokens','systemmsg','systemclear'];
    const diffSubs = ['on','off','threshold','maxlines'];

    // File path completions for /save and /log set
    if (line.startsWith('/save ')) {
      const frag = line.slice(6);
      const hits = pathCompleter(frag);
      return [hits.length ? hits : [], line];
    }
    if (line.startsWith('/log set ')) {
      const frag = line.slice(9);
      const hits = pathCompleter(frag);
      return [hits.length ? hits : [], line];
    }

    if (line.startsWith('/todo ')) {
      const after = line.slice(6);
      const hits = todoSubs.filter(s => s.startsWith(after));
      return [hits.length ? hits.map(h => `/todo ${h}`) : [], line];
    }
    if (line.startsWith('/perms ')) {
      const after = line.slice(7);
      const hits = permsSubs.filter(s => s.startsWith(after));
      return [hits.length ? hits.map(h => `/perms ${h}`) : [], line];
    }
    if (line.startsWith('/log ')) {
      const after = line.slice(5);
      const hits = logSubs.filter(s => s.startsWith(after));
      return [hits.length ? hits.map(h => `/log ${h}`) : [], line];
    }
    if (line.startsWith('/debug ')) {
      const after = line.slice(7);
      const hits = debugSubs.filter(s => s.startsWith(after));
      return [hits.length ? hits.map(h => `/debug ${h}`) : [], line];
    }
    if (line.startsWith('/model ')) {
      const after = line.slice(7);
      const hits = modelSubs.filter(s => s.startsWith(after));
      return [hits.length ? hits.map(h => `/model ${h}`) : [], line];
    }
    if (line.startsWith('/diff ')) {
      const after = line.slice(6);
      const hits = diffSubs.filter(s => s.startsWith(after));
      return [hits.length ? hits.map(h => `/diff ${h}`) : [], line];
    }

    const hits = commands.filter(c => c.startsWith(line));
    return [hits.length ? hits : [], line];
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, completer });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  console.log('Interactive mode. Type /help for commands.');
  console.log(`Session file: ${sessionFile || 'N/A'}`);

  // Lazy-load diff library for preview; disable preview if unavailable
  let createTwoFilesPatchFn = null;
  try {
    const mod = await import('diff');
    createTwoFilesPatchFn = mod.createTwoFilesPatch;
  } catch (_) {
    // Best-effort: if missing, keep running without preview
    diffPreview.enabled = false;
  }

  // Define tool specifications for function calling
  const toolDefinitions = [
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Run a shell command in the project directory and return stdout/stderr/exitCode. Note: This is non-interactive; commands/scripts that require additional user input (prompts) will not work.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The bash command to execute.' },
            timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds.', minimum: 100, maximum: 600000 }
          },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_files',
        description: 'Search for files by name substring within the current workspace directory.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Case-insensitive substring to match in file paths.' },
            maxResults: { type: 'number', description: 'Maximum number of results to return.', minimum: 1, maximum: 500 }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'path_exists',
        description: 'Check if a file or directory exists and whether it is a directory.',
        parameters: {
          type: 'object',
          properties: {
            targetPath: { type: 'string', description: 'Path to check, relative or absolute.' }
          },
          required: ['targetPath']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_dir',
        description: 'Get the immediate contents of a directory.',
        parameters: {
          type: 'object',
          properties: {
            dirPath: { type: 'string', description: 'Directory path.' },
            includeTypes: { type: 'boolean', description: 'Include entry types (file/dir).' }
          },
          required: ['dirPath']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a text file and return its contents (truncated to 200KB).',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Path to the file.' },
            maxBytes: { type: 'number', description: 'Optional max bytes to read (<= 200000).' }
          },
          required: ['filePath']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create or overwrite a text file with provided content.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Path to the file to write.' },
            content: { type: 'string', description: 'Full file content to write.' }
          },
          required: ['filePath', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'patch_file',
        description: 'Apply structured text edits to a file (line or regex based). Operations: replace_range, insert_at, replace_regex, append, prepend.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Path to the file to modify.' },
            operations: {
              type: 'array',
              description: 'Ordered list of patch operations to apply.',
              items: {
                type: 'object',
                properties: {
                  op: { type: 'string', enum: ['replace_range', 'insert_at', 'replace_regex', 'append', 'prepend'] },
                  // replace_range
                  startLine: { type: 'number', description: '1-based start line for replace_range.' },
                  endLine: { type: 'number', description: '1-based end line (inclusive) for replace_range.' },
                  newContent: { type: 'string', description: 'New content for replace/insert/append/prepend.' },
                  // insert_at
                  line: { type: 'number', description: '1-based line for insert_at.' },
                  position: { type: 'string', enum: ['before', 'after'], description: 'Insert before/after the given line.' },
                  // replace_regex
                  pattern: { type: 'string', description: 'Regex pattern string (no delimiters).'},
                  flags: { type: 'string', description: 'Regex flags, e.g., gmi.' },
                },
                required: ['op']
              }
            }
          },
          required: ['filePath', 'operations']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'manage_todo',
        description: 'Create, update, list, or delete todo items for this interactive session.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'list', 'update', 'delete', 'complete'], description: 'The action to perform.' },
            id: { type: 'number', description: 'Todo ID for update/delete/complete.' },
            title: { type: 'string', description: 'Short title for create/update.' },
            description: { type: 'string', description: 'Detailed notes.' }
          },
          required: ['action']
        }
      }
    }
  ];

  function logLine(line) {
    if (!logging.enabled) return;
    try {
      fs.appendFileSync(logging.file, `[${new Date().toISOString()}] ${line}\n`);
    } catch (_) {}
  }

  function colorizePatch(patch) {
    const reset = '\x1b[0m';
    const green = '\x1b[32m';
    const red = '\x1b[31m';
    const cyan = '\x1b[36m';
    const dim = '\x1b[2m';
    return patch.split('\n').map(line => {
      if (line.startsWith('+++') || line.startsWith('---')) return dim + line + reset;
      if (line.startsWith('@@')) return cyan + line + reset;
      if (line.startsWith('+') && !line.startsWith('+++')) return green + line + reset;
      if (line.startsWith('-') && !line.startsWith('---')) return red + line + reset;
      return line;
    }).join('\n');
  }

  async function maybePreviewAndConfirmDiff(filePath, before, after) {
    // Estimate changed lines
    const A = String(before ?? '').split('\n');
    const B = String(after ?? '').split('\n');
    const maxLen = Math.max(A.length, B.length);
    let changed = 0;
    for (let i = 0; i < maxLen; i++) if (A[i] !== B[i]) changed++;

    if (!diffPreview.enabled || changed < diffPreview.thresholdLines || !createTwoFilesPatchFn) {
      return { proceed: true, changed };
    }
    const patch = createTwoFilesPatchFn(filePath, filePath, String(before ?? ''), String(after ?? ''), '', '');
    const lines = patch.split('\n');
    const head = lines.slice(0, diffPreview.maxLines);
    const truncated = lines.length > diffPreview.maxLines;
    const preview = colorizePatch(head.join('\n')) + (truncated ? `\n[Diff truncated to ${diffPreview.maxLines} line(s)]` : '');
    console.log(preview);
    const ok = await askYesNo(`Apply these changes to ${filePath}?`);
    if (!ok) {
      console.log('[Change aborted]');
      logLine(`DIFF_ABORT path=${filePath} changedLines=${changed}`);
      return { proceed: false, changed };
    }
    logLine(`DIFF_APPLY path=${filePath} changedLines=${changed}`);
    return { proceed: true, changed };
  }

  async function askYesNo(promptText) {
    while (true) {
      const ans = (await ask(`${promptText} [y/n]: `)).trim().toLowerCase();
      if (ans === 'y' || ans === 'yes') return true;
      if (ans === 'n' || ans === 'no') return false;
    }
  }

  // Tool runners with optional permission prompts
  async function runLocalTool(toolName, args) {
    // In-session permission cache: commands always require consent; files can reuse
    const permissionCache = runLocalTool._permCache || (runLocalTool._permCache = { read: new Set(), write: new Set() });
    function hasPerm(kind, absPath) { return (permissionCache[kind] && permissionCache[kind].has(absPath)) || false; }
    function grantPerm(kind, absPath) { if (permissionCache[kind]) permissionCache[kind].add(absPath); }
    function countChangedLines(a, b) {
      const A = String(a ?? '').split('\n');
      const B = String(b ?? '').split('\n');
      const maxLen = Math.max(A.length, B.length);
      let changed = 0;
      for (let i = 0; i < maxLen; i++) {
        const la = A[i];
        const lb = B[i];
        if (la !== lb) changed++;
      }
      return changed;
    }
    try {
      switch (toolName) {
        case 'run_command': {
          const cmd = args?.command || '';
          const ok = await askYesNo(`ChatGPT would like to run: ${cmd}`);
          if (!ok) return JSON.stringify({ error: 'Permission denied by user.' });
          if (debugEnabled) console.log(`[Tool call] run_command ${JSON.stringify({ command: cmd, timeoutMs: args?.timeoutMs ?? undefined })}`);
          logLine(`CALL run_command args=${JSON.stringify({ command: cmd, timeoutMs: args?.timeoutMs ?? undefined })}`);
          return await new Promise((resolve) => {
            const child = spawn(cmd, { shell: true, cwd: process.cwd() });
            let stdout = '';
            let stderr = '';
            const timeoutMs = Math.min(Math.max(Number(args?.timeoutMs) || 0, 0), 600000);
            let timer = null;
            if (timeoutMs > 0) {
              timer = setTimeout(() => {
                try { child.kill('SIGKILL'); } catch(_) {}
              }, timeoutMs);
            }
            child.stdout.on('data', (d) => { stdout += d.toString(); });
            child.stderr.on('data', (d) => { stderr += d.toString(); });
            child.on('close', (code) => {
              if (timer) clearTimeout(timer);
              console.log(`[Ran command (exit ${code ?? 'null'})]`);
              if (debugEnabled) {
                if (stdout) console.log(`[stdout]\n${stdout}`);
                if (stderr) console.log(`[stderr]\n${stderr}`);
              }
              logLine(`RESULT run_command exit=${code} stdout_len=${stdout.length} stderr_len=${stderr.length}`);
              resolve(JSON.stringify({ exitCode: code, stdout, stderr }));
            });
            child.on('error', (e) => {
              if (timer) clearTimeout(timer);
              logLine(`ERROR run_command ${e?.message || String(e)}`);
              resolve(JSON.stringify({ exitCode: null, error: e?.message || String(e) }));
            });
          });
        }
        case 'search_files': {
          const q = String(args?.query || '').toLowerCase();
          const max = Math.min(Math.max(Number(args?.maxResults) || 100, 1), 500);
          const results = [];
          function walk(dir) {
            let entries = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(_) { return; }
            for (const e of entries) {
              const full = path.join(dir, e.name);
              const rel = path.relative(process.cwd(), full);
              if (rel.toLowerCase().includes(q)) results.push(rel);
              if (results.length >= max) return;
              if (e.isDirectory()) walk(full);
              if (results.length >= max) return;
            }
          }
          walk(process.cwd());
          console.log(`[Found ${results.length} file(s) matching "${q}"]`);
          if (debugEnabled) console.log(`[Tool call] search_files ${JSON.stringify({ query: q, maxResults: max })}`);
          logLine(`CALL search_files args=${JSON.stringify({ query: q, maxResults: max })}`);
          logLine(`RESULT search_files count=${results.length}`);
          return JSON.stringify({ results });
        }
        case 'path_exists': {
          const p = path.resolve(process.cwd(), String(args?.targetPath || ''));
          try {
            const st = fs.statSync(p);
            console.log(`[Path exists: ${p} (${st.isDirectory() ? 'dir' : 'file'})]`);
            if (debugEnabled) console.log(`[Tool call] path_exists ${JSON.stringify({ targetPath: p })}`);
            logLine(`CALL path_exists args=${JSON.stringify({ targetPath: p })}`);
            return JSON.stringify({ exists: true, isDirectory: st.isDirectory(), isFile: st.isFile(), path: p });
          } catch (_) {
            console.log(`[Path not found: ${p}]`);
            logLine(`CALL path_exists args=${JSON.stringify({ targetPath: p })}`);
            return JSON.stringify({ exists: false, path: p });
          }
        }
        case 'read_dir': {
          const p = path.resolve(process.cwd(), String(args?.dirPath || ''));
          try {
            const items = fs.readdirSync(p, { withFileTypes: true }).map((d) => {
              const o = { name: d.name };
              if (args?.includeTypes) o.type = d.isDirectory() ? 'dir' : (d.isFile() ? 'file' : 'other');
              return o;
            });
            console.log(`[Listed directory: ${p} (${items.length} entries)]`);
            if (debugEnabled) console.log(`[Tool call] read_dir ${JSON.stringify({ dirPath: p, includeTypes: !!args?.includeTypes })}`);
            logLine(`CALL read_dir args=${JSON.stringify({ dirPath: p, includeTypes: !!args?.includeTypes })}`);
            logLine(`RESULT read_dir count=${items.length}`);
            return JSON.stringify({ path: p, items });
          } catch (e) {
            return JSON.stringify({ error: e?.message || String(e), path: p });
          }
        }
        case 'read_file': {
          const p = path.resolve(process.cwd(), String(args?.filePath || ''));
          if (hasPerm('read', p)) {
            console.log(`[Using prior permission for read: ${p}]`);
          } else {
            const ok = await askYesNo(`ChatGPT would like to access (read): ${p}`);
            if (!ok) return JSON.stringify({ error: 'Permission denied by user.' });
            grantPerm('read', p);
          }
          if (debugEnabled) console.log(`[Tool call] read_file ${JSON.stringify({ filePath: p, maxBytes: args?.maxBytes ?? undefined })}`);
          logLine(`CALL read_file args=${JSON.stringify({ filePath: p, maxBytes: args?.maxBytes ?? undefined })}`);
          try {
            const max = Math.min(Math.max(Number(args?.maxBytes) || 200000, 1), 200000);
            const fd = fs.openSync(p, 'r');
            const buf = Buffer.allocUnsafe(max);
            const bytes = fs.readSync(fd, buf, 0, max, 0);
            fs.closeSync(fd);
            const content = buf.slice(0, bytes).toString('utf8');
            const total = fs.statSync(p).size;
            console.log(`[Read ${bytes}/${total} bytes from ${p}${total > bytes ? ' (truncated)' : ''}]`);
            logLine(`RESULT read_file bytes=${bytes} total=${total}`);
            return JSON.stringify({ path: p, content, truncated: total > bytes, bytesRead: bytes });
          } catch (e) {
            logLine(`ERROR read_file ${e?.message || String(e)}`);
            return JSON.stringify({ error: e?.message || String(e), path: p });
          }
        }
        case 'write_file': {
          const p = path.resolve(process.cwd(), String(args?.filePath || ''));
          if (hasPerm('write', p)) {
            console.log(`[Using prior permission for write: ${p}]`);
          } else {
            const ok = await askYesNo(`ChatGPT would like to access (write): ${p}`);
            if (!ok) return JSON.stringify({ error: 'Permission denied by user.' });
            grantPerm('write', p);
          }
          if (debugEnabled) console.log(`[Tool call] write_file ${JSON.stringify({ filePath: p, contentBytes: (args?.content || '').length })}`);
          logLine(`CALL write_file args=${JSON.stringify({ filePath: p, contentBytes: (args?.content || '').length })}`);
          try {
            let before = '';
            let existed = false;
            try { before = fs.readFileSync(p, 'utf8'); existed = true; } catch(_) {}
            const after = String(args?.content || '');
            if (existed) {
              const decision = await maybePreviewAndConfirmDiff(p, before, after);
              if (!decision.proceed) return JSON.stringify({ path: p, ok: false, aborted: true });
            }
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, after, 'utf8');
            if (existed) {
              const changed = countChangedLines(before, after);
              console.log(`[Changed ${changed} line(s) of text in ${p}]`);
            } else {
              const lines = String(after).split('\n').length;
              console.log(`[Created ${p} with ${lines} line(s)]`);
            }
            logLine(`RESULT write_file ok=true`);
            return JSON.stringify({ path: p, ok: true });
          } catch (e) {
            logLine(`ERROR write_file ${e?.message || String(e)}`);
            return JSON.stringify({ error: e?.message || String(e), path: p });
          }
        }
        case 'patch_file': {
          const p = path.resolve(process.cwd(), String(args?.filePath || ''));
          if (hasPerm('write', p)) {
            console.log(`[Using prior permission for write: ${p}]`);
          } else {
            const ok = await askYesNo(`ChatGPT would like to patch (write): ${p}`);
            if (!ok) return JSON.stringify({ error: 'Permission denied by user.' });
            grantPerm('write', p);
          }
          if (debugEnabled) console.log(`[Tool call] patch_file ${JSON.stringify({ filePath: p, operations: Array.isArray(args?.operations) ? args.operations.length : 0 })}`);
          logLine(`CALL patch_file args=${JSON.stringify({ filePath: p, operations: Array.isArray(args?.operations) ? args.operations.length : 0 })}`);
          try {
            if (!fs.existsSync(p)) return JSON.stringify({ error: 'File does not exist', path: p });
            let content = fs.readFileSync(p, 'utf8');
            const original = content;
            const ops = Array.isArray(args?.operations) ? args.operations : [];
            if (!ops.length) return JSON.stringify({ error: 'No operations provided', path: p });

            const applyOps = () => {
              for (const op of ops) {
                const kind = String(op.op || '').toLowerCase();
                if (kind === 'replace_range') {
                  const start = Number(op.startLine);
                  const end = Number(op.endLine);
                  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
                    throw new Error('Invalid startLine/endLine');
                  }
                  const lines = content.split('\n');
                  const before = lines.slice(0, start - 1);
                  const after = lines.slice(end);
                  const mid = String(op.newContent ?? '');
                  const midLines = mid.length ? mid.split('\n') : [];
                  content = [...before, ...midLines, ...after].join('\n');
                } else if (kind === 'insert_at') {
                  const line = Number(op.line);
                  const pos = (op.position || 'before').toLowerCase();
                  if (!Number.isInteger(line) || line < 1) throw new Error('Invalid line');
                  const lines = content.split('\n');
                  const idx = pos === 'after' ? line : line - 1; // after inserts after given line
                  const addLines = String(op.newContent ?? '').split('\n');
                  const head = lines.slice(0, idx);
                  const tail = lines.slice(idx);
                  content = [...head, ...addLines, ...tail].join('\n');
                } else if (kind === 'replace_regex') {
                  const pat = String(op.pattern || '');
                  const flags = String(op.flags || '');
                  const re = new RegExp(pat, flags);
                  const repl = String(op.newContent ?? '');
                  content = content.replace(re, repl);
                } else if (kind === 'append') {
                  content = content + String(op.newContent ?? '');
                } else if (kind === 'prepend') {
                  content = String(op.newContent ?? '') + content;
                } else {
                  throw new Error(`Unsupported op: ${kind}`);
                }
              }
            };

            applyOps();
            const decision = await maybePreviewAndConfirmDiff(p, original, content);
            if (!decision.proceed) return JSON.stringify({ path: p, ok: false, aborted: true });
            fs.writeFileSync(p, content, 'utf8');
            const changed = countChangedLines(original, content);
            console.log(`[Changed ${changed} line(s) of text in ${p}]`);
            logLine(`RESULT patch_file changedLines=${changed}`);
            return JSON.stringify({ path: p, ok: true, changedLines: changed });
          } catch (e) {
            logLine(`ERROR patch_file ${e?.message || String(e)}`);
            return JSON.stringify({ error: e?.message || String(e), path: p });
          }
        }
        case 'manage_todo': {
          const action = String(args?.action || '').toLowerCase();
          if (action === 'create') {
            const id = todoList.length ? Math.max(...todoList.map(t => t.id)) + 1 : 1;
            const item = { id, title: String(args?.title || 'Untitled'), description: String(args?.description || ''), status: 'not-started' };
            todoList.push(item);
            if (todoList.length === 1) console.log('[Created TODO List]');
            console.log('[Added 1 item to TODO List]');
            await saveSession();
            return JSON.stringify({ ok: true, item });
          }
          if (action === 'list') {
            console.log(`[TODO List: ${todoList.length} item(s)]`);
            return JSON.stringify({ items: todoList });
          }
          if (action === 'update') {
            const id = Number(args?.id);
            const it = todoList.find(t => t.id === id);
            if (!it) return JSON.stringify({ error: 'Not found' });
            if (args?.title != null) it.title = String(args.title);
            if (args?.description != null) it.description = String(args.description);
            console.log(`[Updated TODO item #${id}]`);
            await saveSession();
            return JSON.stringify({ ok: true, item: it });
          }
          if (action === 'complete') {
            const id = Number(args?.id);
            const it = todoList.find(t => t.id === id);
            if (!it) return JSON.stringify({ error: 'Not found' });
            it.status = 'completed';
            console.log('[Marked 1 TODO List item as completed]');
            await saveSession();
            return JSON.stringify({ ok: true, item: it });
          }
          if (action === 'delete') {
            const id = Number(args?.id);
            const idx = todoList.findIndex(t => t.id === id);
            if (idx === -1) return JSON.stringify({ error: 'Not found' });
            const [removed] = todoList.splice(idx, 1);
            console.log('[Deleted 1 TODO List item]');
            await saveSession();
            return JSON.stringify({ ok: true, removed });
          }
          return JSON.stringify({ error: 'Unsupported action' });
        }
        default:
          return JSON.stringify({ error: `Unknown tool: ${toolName}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  }

  async function runModelWithTools() {
    // Note: caller may attach an AbortController through arguments via binding/closure
    const controller = runModelWithTools._controller;
    for (let step = 0; step < 20; step++) {
      const completion = await client.chat.completions.create({
        model: options.model,
        messages: toChatMessages(),
        tools: toolDefinitions,
        temperature: typeof options.temperature === 'number' && !Number.isNaN(options.temperature) ? options.temperature : undefined,
        max_tokens: typeof options.maxTokens === 'number' && !Number.isNaN(options.maxTokens) ? options.maxTokens : undefined,
      }, controller ? { signal: controller.signal } : undefined);

      const msg = completion.choices?.[0]?.message || {};
      const toolCalls = msg.tool_calls || [];

      if (toolCalls.length > 0) {
        if (debugEnabled) {
          for (const tc of toolCalls) {
            console.log(`[Model requested tool] ${tc.function?.name} ${tc.function?.arguments || ''}`);
          }
        }
        for (const tc of toolCalls) {
          // Record assistant tool call message
          chatHistory.push({ role: 'assistant', content: msg.content || null, tool_calls: [tc] });
          logLine(`TOOL_REQUEST name=${tc.function?.name} args=${tc.function?.arguments || ''}`);
          let args = {};
          try { args = JSON.parse(tc.function?.arguments || '{}'); } catch(_) { args = {}; }
          const result = await runLocalTool(tc.function?.name, args);
          chatHistory.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
        continue; // Ask the model again with tool outputs
      }

      // Final assistant message (no tool calls)
      const reply = (msg.content || '').trim();
      if (!options.quiet && reply) console.log(reply);
      chatHistory.push({ role: 'assistant', content: reply });
      await saveSession();
      if (options.out) fs.writeFileSync(options.out, reply);
      break;
    }
  }

  async function agenticExchange(userInput) {
    // Add the prompt to chat history
    chatHistory.push({ role: 'user', content: buildUserContent(userInput) });
    // Set up cancel-on-keypress (F/f)
    const controller = new AbortController();
    runModelWithTools._controller = controller;
    let prevRaw = undefined;
    const onData = (buf) => {
      const s = buf.toString();
      const ch = s.length ? s[0] : '';
      if (ch === 'f' || ch === 'F') {
        try { controller.abort(); } catch(_) {}
      }
    };
    try {
      // Put stdin into raw mode to capture single key presses during generation
      if (process.stdin.isTTY) {
        prevRaw = process.stdin.isRaw;
        try { process.stdin.setRawMode(true); } catch(_) {}
        process.stdin.on('data', onData);
      }
      console.log('[Press F to cancel]');
      await runModelWithTools();
    } catch (e) {
      const msg = (e?.name || '').toString();
      if (msg === 'AbortError' || /aborted|abort/i.test(e?.message || '')) {
        console.log('[Cancelled]');
      } else {
        throw e;
      }
    } finally {
      runModelWithTools._controller = null;
      if (process.stdin.isTTY) {
        process.stdin.off('data', onData);
        try { process.stdin.setRawMode(!!prevRaw); } catch(_) {}
      }
    }
  }
  while (true) {
    const input = await ask('> ');
    if (!input) continue;
    if (input.trim() === '/help') {
      console.log('Commands:');
      console.log('  /help                Show this help menu');
      console.log('  /exit                Exit interactive mode');
      console.log('  /save <filename>     Save session history and set as active session');
      console.log('  /perms [list|clear]  View or clear cached file permissions');
      console.log('  /log [on|off|set <file>]  Log tool calls and args to file');
      console.log('  /debug [on|off]      Print tool calls and command outputs');
      console.log('  /model [set <id>|temp <n>|maxtokens <n>|systemmsg <text>|systemclear]');
      console.log('  /retry               Retry the last assistant response');
      console.log('  /edit                Edit last user message and resend');
      console.log('  /reset               Clear chat history and tool state');
      console.log('  /restart             Clear screen, tool state, and permissions');
      console.log('  /clear               Clear the screen');
      console.log('  /diff [on|off|threshold <n>|maxlines <n>]  Configure diff preview');
      console.log('Tips: Press F during a model response to cancel.');
      console.log('  /todo list           Show TODO items');
      console.log('  /todo add <title> [| <desc>]');
      console.log('  /todo update <id> <title> [| <desc>]');
      console.log('  /todo complete <id>');
      console.log('  /todo delete <id>');
      continue;
    }
    if (input.trim().startsWith('/todo')) {
      const raw = input.trim();
      const parts = raw.split(/\s+/);
      const sub = parts[1] || '';
      const rest = raw.replace(/^\/todo\s+[^\s]+\s*/, '');
      const splitTitleDesc = (text) => {
        const idx = text.indexOf('|');
        if (idx === -1) return { title: text.trim(), description: '' };
        return { title: text.slice(0, idx).trim(), description: text.slice(idx + 1).trim() };
      };
      const nextId = () => (todoList.length ? Math.max(...todoList.map(t => t.id)) + 1 : 1);

      if (sub === 'list' || sub === '') {
        console.log(`[TODO List: ${todoList.length} item(s)]`);
        for (const t of todoList) {
          const box = t.status === 'completed' ? '[x]' : '[ ]';
          const desc = t.description ? ` — ${t.description}` : '';
          console.log(`  ${box} #${t.id} ${t.title}${desc}`);
        }
        continue;
      }
      if (sub === 'add') {
        if (!rest) { console.log('Usage: /todo add <title> [| <desc>]'); continue; }
        const { title, description } = splitTitleDesc(rest);
        const item = { id: nextId(), title: title || 'Untitled', description: description || '', status: 'not-started' };
        todoList.push(item);
        if (todoList.length === 1) console.log('[Created TODO List]');
        console.log('[Added 1 item to TODO List]');
        await saveSession();
        continue;
      }
      if (sub === 'update') {
        const idStr = parts[2];
        if (!idStr) { console.log('Usage: /todo update <id> <title> [| <desc>]'); continue; }
        const id = Number(idStr);
        if (!Number.isInteger(id)) { console.error('Invalid id.'); continue; }
        const text = raw.replace(/^\/todo\s+update\s+\d+\s*/, '');
        if (!text) { console.log('Usage: /todo update <id> <title> [| <desc>]'); continue; }
        const { title, description } = splitTitleDesc(text);
        const it = todoList.find(t => t.id === id);
        if (!it) { console.error('Not found'); continue; }
        if (title) it.title = title;
        if (description !== undefined) it.description = description;
        console.log(`[Updated TODO item #${id}]`);
        await saveSession();
        continue;
      }
      if (sub === 'complete') {
        const idStr = parts[2];
        const id = Number(idStr);
        if (!Number.isInteger(id)) { console.error('Usage: /todo complete <id>'); continue; }
        const it = todoList.find(t => t.id === id);
        if (!it) { console.error('Not found'); continue; }
        it.status = 'completed';
        console.log('[Marked 1 TODO List item as completed]');
        await saveSession();
        continue;
      }
      if (sub === 'delete') {
        const idStr = parts[2];
        const id = Number(idStr);
        if (!Number.isInteger(id)) { console.error('Usage: /todo delete <id>'); continue; }
        const idx = todoList.findIndex(t => t.id === id);
        if (idx === -1) { console.error('Not found'); continue; }
        todoList.splice(idx, 1);
        console.log('[Deleted 1 TODO List item]');
        await saveSession();
        continue;
      }
      console.error('Unknown /todo subcommand. Type /help for commands.');
      continue;
    }
    if (input.trim().startsWith('/save')) {
      const parts = input.trim().split(/\s+/);
      const fname = parts[1];
      if (!fname) {
        console.log('Usage: /save <filename>');
      } else {
        sessionFile = ensureGptpExt(fname);
        await saveSession();
        console.log(`Session file: ${sessionFile}`);
      }
      continue;
    }
    if (input.trim().startsWith('/perms')) {
      const parts = input.trim().split(/\s+/);
      const sub = parts[1] || '';
      const cache = (runLocalTool._permCache ||= { read: new Set(), write: new Set() });
      if (sub === 'list' || sub === '') {
        const read = Array.from(cache.read);
        const write = Array.from(cache.write);
        console.log('[Permissions]');
        console.log(`  read (${read.length})`);
        for (const p of read) console.log(`   - ${p}`);
        console.log(`  write (${write.length})`);
        for (const p of write) console.log(`   - ${p}`);
      } else if (sub === 'clear') {
        cache.read.clear();
        cache.write.clear();
        console.log('[Cleared cached permissions]');
      } else {
        console.error('Usage: /perms [list|clear]');
      }
      continue;
    }
    if (input.trim().startsWith('/log')) {
      const parts = input.trim().split(/\s+/);
      const sub = parts[1] || '';
      if (sub === 'on') {
        logging.enabled = true;
        console.log(`[Logging enabled -> ${logging.file}]`);
      } else if (sub === 'off') {
        logging.enabled = false;
        console.log('[Logging disabled]');
      } else if (sub === 'set') {
        const fname = parts[2];
        if (!fname) { console.log('Usage: /log set <filename>'); }
        else { logging.file = fname; console.log(`[Log file set -> ${logging.file}]`); }
      } else if (sub === '') {
        console.log(`[Logging ${logging.enabled ? 'on' : 'off'} -> ${logging.file}]`);
      } else {
        console.log('Usage: /log [on|off|set <filename>]');
      }
      continue;
    }
    if (input.trim().startsWith('/diff')) {
      const parts = input.trim().split(/\s+/);
      const sub = parts[1] || '';
      if (!sub) {
        console.log(`[Diff preview ${diffPreview.enabled ? 'on' : 'off'}] threshold=${diffPreview.thresholdLines} maxLines=${diffPreview.maxLines}`);
      } else if (sub === 'on') {
        diffPreview.enabled = true;
        console.log('[Diff preview on]');
        await saveSession();
      } else if (sub === 'off') {
        diffPreview.enabled = false;
        console.log('[Diff preview off]');
        await saveSession();
      } else if (sub === 'threshold') {
        const n = parseInt(parts[2], 10);
        if (!Number.isInteger(n) || n < 0) console.log('Usage: /diff threshold <n>');
        else { diffPreview.thresholdLines = n; console.log(`[Diff threshold -> ${n}]`); await saveSession(); }
      } else if (sub === 'maxlines') {
        const n = parseInt(parts[2], 10);
        if (!Number.isInteger(n) || n < 10) console.log('Usage: /diff maxlines <n> (>=10)');
        else { diffPreview.maxLines = n; console.log(`[Diff max lines -> ${n}]`); await saveSession(); }
      } else {
        console.log('Usage: /diff [on|off|threshold <n>|maxlines <n>]');
      }
      continue;
    }
    if (input.trim().startsWith('/debug')) {
      const parts = input.trim().split(/\s+/);
      const sub = parts[1] || '';
      if (sub === 'on') { debugEnabled = true; console.log('[Debug on]'); }
      else if (sub === 'off') { debugEnabled = false; console.log('[Debug off]'); }
      else { console.log(`[Debug ${debugEnabled ? 'on' : 'off'}]`); }
      continue;
    }
    if (input.trim().startsWith('/model')) {
      const raw = input.trim();
      const parts = raw.split(/\s+/);
      const sub = parts[1];
      if (!sub) {
        const sys = chatHistory.find(m => m.role === 'system');
        console.log(`[Model=${options.model}] [temp=${typeof options.temperature === 'number' ? options.temperature : 'default'}] [maxTokens=${typeof options.maxTokens === 'number' ? options.maxTokens : 'default'}]`);
        console.log(`System: ${sys ? (sys.content || '').slice(0, 120) + ((sys.content || '').length > 120 ? '…' : '') : '(none)'}`);
      } else if (sub === 'set') {
        const id = parts[2];
        if (!id) console.log('Usage: /model set <id>');
        else { options.model = id; console.log(`[Model set -> ${id}]`); }
      } else if (sub === 'temp') {
        const v = parseFloat(parts[2]);
        if (Number.isNaN(v)) console.log('Usage: /model temp <number>');
        else { options.temperature = v; console.log(`[Temperature -> ${v}]`); }
      } else if (sub === 'maxtokens') {
        const v = parseInt(parts[2], 10);
        if (Number.isNaN(v)) console.log('Usage: /model maxtokens <number>');
        else { options.maxTokens = v; console.log(`[Max tokens -> ${v}]`); }
      } else if (sub === 'systemmsg') {
        const text = raw.replace(/^\/model\s+systemmsg\s*/, '');
        const idx = chatHistory.findIndex(m => m.role === 'system');
        if (idx >= 0) chatHistory[idx].content = text;
        else chatHistory.unshift({ role: 'system', content: text });
        await saveSession();
        console.log('[System message set]');
      } else if (sub === 'systemclear') {
        chatHistory = chatHistory.filter(m => m.role !== 'system');
        await saveSession();
        console.log('[System message cleared]');
      } else {
        console.log('Usage: /model [set <id>|temp <n>|maxtokens <n>|systemmsg <text>|systemclear]');
      }
      continue;
    }
    if (input.trim() === '/retry') {
      // Remove last assistant message if present
      for (let i = chatHistory.length - 1; i >= 0; i--) {
        if (chatHistory[i].role === 'assistant') { chatHistory.splice(i, 1); break; }
      }
      await runModelWithTools();
      continue;
    }
    if (input.trim() === '/edit') {
      // Edit last user message, drop messages after it, then re-run
      let lastUserIndex = -1;
      for (let i = chatHistory.length - 1; i >= 0; i--) {
        if (chatHistory[i].role === 'user') { lastUserIndex = i; break; }
      }
      if (lastUserIndex === -1) { console.error('No user message to edit.'); continue; }
      const newMsg = await ask('New message: ');
      chatHistory = chatHistory.slice(0, lastUserIndex + 1);
      chatHistory[lastUserIndex].content = buildUserContent(newMsg);
      await runModelWithTools();
      continue;
    }
    if (input.trim() === '/reset') {
      // Clear chat history (preserve system message) and tool state
      chatHistory = chatHistory.filter(m => m.role === 'system');
      const cache = (runLocalTool._permCache ||= { read: new Set(), write: new Set() });
      cache.read.clear();
      cache.write.clear();
      debugEnabled = false;
      logging.enabled = false;
      await saveSession();
      console.log('[Reset: cleared chat history and tool state]');
      continue;
    }
    if (input.trim() === '/restart') {
      // Clear screen, tool state, and permissions (do not modify chat history)
      if (typeof console.clear === 'function') console.clear();
      else process.stdout.write('\x1b[2J\x1b[H');
      const cache = (runLocalTool._permCache ||= { read: new Set(), write: new Set() });
      cache.read.clear();
      cache.write.clear();
      debugEnabled = false;
      logging.enabled = false;
      console.log('[Restarted: cleared screen and tool state]');
      continue;
    }
    if (input.trim() === '/clear') {
      // Clear the terminal screen
      if (typeof console.clear === 'function') console.clear();
      else process.stdout.write('\x1b[2J\x1b[H');
      continue;
    }
    if (input.trim() === '/exit') break;
    if (input.trim().startsWith('/')) {
      const cmd = input.trim().split(/\s+/)[0];
      console.error(`Unknown command: ${cmd}. Type /help for commands.`);
      continue;
    }
    await agenticExchange(input);
  }
  rl.close();
}

async function main() {
  if (options.update) {
    runUpdateAndExit();
    return; // process will exit in handler
  }

  if (options.setDefaultModel) {
    const cfg = readConfig();
    cfg.defaultModel = options.setDefaultModel;
    const ok = writeConfig(cfg);
    if (ok) {
      console.log(`Default model set to ${options.setDefaultModel}`);
      process.exit(0);
    } else {
      process.exit(1);
    }
    return;
  }

  const interactiveRequested = options.interactive || (!prompt && process.stdin.isTTY);
  if (interactiveRequested) {
    await startInteractive();
    return;
  }

  if (!prompt && !interactiveRequested) {
    console.error('Error: Missing prompt. Provide a prompt or use --interactive.');
    process.exit(1);
  }

  await chatOnce(prompt);
}

main();

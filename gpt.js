#! /usr/bin/env node
import { Command } from "commander";
import { OpenAI } from "openai";
import fs from "fs";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const program = new Command();
const client = new OpenAI();

program
  .name('gpt')
  .description('Simple ChatGPT CLI')
  .argument('[prompt]', 'GPT prompt. If omitted, starts interactive mode.')
  .option('-i, --in <filepath>', 'Input file passed with prompt')
  .option('-o, --out <filepath>', 'Response output (will still print)')
  .option('-r, --role <message>', 'Add system message before the prompt')
  .option('-d, --dev', 'Append prompt with dev rules for output')
  .option('-m, --model <id>', 'The model to prompt', 'gpt-4.1-mini')
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
    chatHistory = JSON.parse(data);
  } catch (e) {
    // If error reading session, start fresh
    chatHistory = [];
  }
}

async function saveSession() {
  if (sessionFile) {
    fs.writeFileSync(sessionFile, JSON.stringify(chatHistory, null, 2));
  }
}

function buildUserContent(text) {
  return (options.in ? fileData + "\n" : "") + text + (options.dev ? "\nDon't respond with anything other than code. Don't include any markdown." : "");
}

function toChatMessages() {
  // Ensure only valid roles for Chat Completions API
  return chatHistory.map(m => ({ role: m.role, content: m.content }));
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

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  console.log('Interactive mode. Type /exit to quit.');
  while (true) {
    const input = await ask('> ');
    if (!input) continue;
    if (input.trim() === '/exit') break;
    await chatOnce(input);
  }
  rl.close();
}

async function main() {
  if (options.update) {
    runUpdateAndExit();
    return; // process will exit in handler
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

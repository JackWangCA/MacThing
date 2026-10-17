import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Only initialize the CLI's SDK transport. No user message is ever sent, so this does not
// make a model request. Claude Code owns refresh-token rotation, locking, and persistence.
export const AUTH_ARGS = [
  '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--no-session-persistence', '--tools', '', '--disable-slash-commands', '--no-chrome',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--settings', '{"disableAllHooks":true}', '--setting-sources', '',
];

export async function findClaude() {
  // A login LaunchAgent's PATH often omits the CLI's native-install directory.
  const dirs = [...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of new Set(dirs.filter(Boolean))) {
    const file = path.join(dir, 'claude');
    if (await fs.access(file, constants.X_OK).then(() => true, () => false)) return file;
  }
  return null;
}

export function isRenewed(auth, previous, now = Date.now()) {
  return !!auth?.accessToken && (!auth.expiresAt || auth.expiresAt > now) &&
    (auth.accessToken !== previous.accessToken || auth.expiresAt > previous.expiresAt);
}

/** Ask the installed Claude Code to renew its own login, without prompts, tools, or hooks.
 * Dependencies are injectable so tests never touch the real Keychain or launch Claude Code. */
export async function renewClaudeCredentials(readCredentials, previous, {
  findExecutable = findClaude, spawnProcess = spawn, timeoutMs = 45000, pollMs = 500,
} = {}) {
  if (isRenewed(await readCredentials(), previous)) return true;
  const executable = await findExecutable();
  if (!executable) return false;
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'macthing-claude-auth-'));
  let child, closed, exited = false;
  try {
    const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    // Use the same default Claude Code login that usage.js reads, rather than a shell's API key,
    // a separate profile, or an inherited session token. Never pass a credential as an argument.
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDECODE']) delete env[key];
    child = spawnProcess(executable, AUTH_ARGS, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    closed = new Promise(resolve => child.once('close', () => { exited = true; resolve(); }));
    let failed = false, initialized = false, buffer = '';
    child.on('error', () => { failed = true; });
    child.stdin.on('error', () => { failed = true; });
    // Do not retain or log CLI stderr or its account information.
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { buffer = ''; failed = true; return; }
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          if (message.type === 'control_response' && message.response?.request_id === 'macthing-auth-init') {
            initialized = message.response.subtype === 'success';
            failed = !initialized;
          }
        } catch { /* Ignore non-protocol output; never include it in logs. */ }
      }
    });
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'macthing-auth-init', request: { subtype: 'initialize', hooks: {} } }) + '\n');
    const deadline = Date.now() + timeoutMs;
    while (!exited && !failed && Date.now() < deadline) {
      const pause = new Promise(resolve => {
        const timer = setTimeout(resolve, pollMs);
        closed.then(() => { clearTimeout(timer); resolve(); });
      });
      await pause;
      if (initialized && isRenewed(await readCredentials(), previous)) return true;
    }
    return isRenewed(await readCredentials(), previous);
  } finally {
    if (child && !exited) {
      // EOF lets the CLI finish and persist an in-flight refresh before it exits. Unlike
      // `auth status`, we keep it alive until the renewed credential is actually readable.
      child.stdin.end();
      const terminate = setTimeout(() => child.kill('SIGTERM'), 10000);
      const kill = setTimeout(() => child.kill('SIGKILL'), 13000);
      await closed;
      clearTimeout(terminate);
      clearTimeout(kill);
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

/**
 * Prueba end-to-end contra un repo git descartable en /tmp: worktree_create
 * -> run -> diff -> bring_changes -> worktree_remove. No toca ningún repo
 * real. Si `cursor-agent` no tiene sesión activa, el paso `run` va a fallar
 * con "Authentication required" — es esperado y normal (correr
 * `cursor-agent login` a mano arregla eso); el resto del test igual valida
 * que el server MCP en sí funciona bien.
 *
 * Uso: node test/e2e-test.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const PROJECT_ROOT = path.join(import.meta.dirname, '..');
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-mcp-testrepo-'));
const WT = `${REPO}-wt`;

function sh(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'ignore' });
}

sh('git', ['init', '-q'], REPO);
sh('git', ['config', 'user.email', 'test@test.com'], REPO);
sh('git', ['config', 'user.name', 'test'], REPO);
fs.writeFileSync(path.join(REPO, 'README.md'), '# test repo\n');
sh('git', ['add', 'README.md'], REPO);
sh('git', ['commit', '-q', '-m', 'init'], REPO);
sh('git', ['branch', '-M', 'main'], REPO);

const child = spawn('node', ['src/server.js'], { cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => console.error('[stderr]', d.toString()));

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      console.log('<-- (no-json)', line.slice(0, 300));
    }
  }
});

let nextId = 1;
function req(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function call(name, args) {
  return req('tools/call', { name, arguments: args });
}
function notify(method, params = {}) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function printResult(label, res) {
  const t = res?.result?.content?.[0]?.text ?? JSON.stringify(res);
  console.log(`\n=== ${label} ===\n${t}`);
  return t;
}

function cleanup() {
  try { fs.rmSync(REPO, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(WT, { recursive: true, force: true }); } catch {}
  child.kill();
}

try {
  await req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  notify('notifications/initialized');

  printResult('check', await call('check', {}));

  printResult('worktree_create', await call('worktree_create', {
    repo_path: REPO, branch: 'test/e2e', base: 'main', worktree_path: WT,
    link_node_modules: false, fetch: false,
  }));

  printResult('run (wait:true)', await call('run', {
    cwd: WT,
    prompt: 'Create a file named hello.txt containing exactly the text: hello from cursor-agent-mcp',
    wait: true, timeout_seconds: 120, label: 'e2e-smoke',
  }));

  printResult('diff (stat_only)', await call('diff', { worktree_path: WT, stat_only: true }));
  printResult('bring_changes', await call('bring_changes', { worktree_path: WT, target_repo_path: REPO }));
  printResult('worktree_remove', await call('worktree_remove', { repo_path: REPO, worktree_path: WT, force: true }));

  console.log('\n✓ e2e test terminó sin excepciones no manejadas.');
} finally {
  cleanup();
  process.exit(0);
}

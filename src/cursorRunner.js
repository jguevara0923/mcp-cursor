import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { getShellEnv, tailLines, DEFAULT_TAIL_LINES } from './util.js';
import { createJob, updateJob, logPath, readLog, loadMeta, liveProcesses } from './jobs.js';

/**
 * Arma los args de `cursor-agent` como ARRAY (nunca como un string armado a
 * mano) — así el prompt puede traer comillas, backticks, `$`, lo que sea, sin
 * que se le escape nada raro a una shell.
 */
function buildArgs({ prompt, model, trust, force, outputFormat, mode, resumeChatId, continueSession }) {
  const args = ['-p'];
  if (trust) args.push('--trust');
  if (force) args.push('--force');
  if (model) args.push('--model', model);
  // 'agent' (default) = sin --mode, lectura+escritura con todas las
  // herramientas. 'plan'/'ask' son de SOLO LECTURA (cursor-agent nunca edita
  // nada) — útiles para pedirle un análisis o un plan sin riesgo de que
  // toque archivos.
  if (mode === 'plan' || mode === 'ask') args.push('--mode', mode);
  if (resumeChatId) args.push('--resume', resumeChatId);
  else if (continueSession) args.push('--continue');
  args.push(prompt);
  args.push('--output-format', outputFormat || 'text');
  return args;
}

/**
 * Lanza un job de cursor-agent en segundo plano. Devuelve el `meta` del job
 * DE INMEDIATO (no espera a que termine) — usá `job_wait`/`job_status` para
 * seguirlo. Este es el primitivo que usan `run`, `plan_run` y
 * `plan_run_parallel`.
 */
export async function launchJob({
  cwd,
  prompt,
  model,
  trust = true,
  force = true,
  outputFormat = 'text',
  mode = 'agent',
  resumeChatId,
  continueSession = false,
  label,
  worktreePath,
  branch,
  repoPath,
}) {
  if (!cwd) throw new Error('Falta "cwd" (o worktree_path) — dónde corre cursor-agent.');
  if (!prompt || !prompt.trim()) throw new Error('Falta "prompt" (o "plan") — qué se le pide a cursor-agent.');

  const args = buildArgs({ prompt, model, trust, force, outputFormat, mode, resumeChatId, continueSession });
  const commandForLog = `cursor-agent ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;

  const meta = await createJob({
    label,
    cwd,
    worktreePath: worktreePath || null,
    branch: branch || null,
    repoPath: repoPath || null,
    command: commandForLog,
    promptPreview: prompt.length > 300 ? `${prompt.slice(0, 300)}…` : prompt,
  });

  const env = await getShellEnv();
  const logStream = fs.createWriteStream(logPath(meta.id), { flags: 'a' });
  logStream.write(`$ ${commandForLog}\n(cwd: ${cwd})\n\n`);

  const child = spawn('cursor-agent', args, { cwd, env });
  liveProcesses.set(meta.id, child);

  await updateJob(meta.id, { status: 'running', pid: child.pid });

  child.stdout.on('data', (d) => logStream.write(d));
  child.stderr.on('data', (d) => logStream.write(d));

  child.on('error', async (err) => {
    logStream.write(`\n[cursor-agent-mcp] Error al lanzar el proceso: ${err.message}\n`);
    logStream.end();
    liveProcesses.delete(meta.id);
    await updateJob(meta.id, { status: 'failed', exitCode: null, endedAt: new Date().toISOString() });
  });

  child.on('close', async (code, signal) => {
    logStream.write(`\n[cursor-agent-mcp] Proceso terminado. code=${code} signal=${signal ?? ''}\n`);
    logStream.end();
    liveProcesses.delete(meta.id);
    const currentMeta = await loadMeta(meta.id);
    const status = currentMeta?.status === 'cancelled' ? 'cancelled' : code === 0 ? 'done' : 'failed';
    await updateJob(meta.id, { status, exitCode: code, endedAt: new Date().toISOString() });
  });

  return meta;
}

export async function waitForJob(id, timeoutSeconds = 1800, pollMs = 1500) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const meta = await loadMeta(id);
    if (!meta) throw new Error(`Job ${id} no existe`);
    if (meta.status === 'done' || meta.status === 'failed' || meta.status === 'cancelled') {
      return meta;
    }
    if (Date.now() > deadline) {
      return { ...meta, timedOut: true };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function cancelJob(id) {
  const child = liveProcesses.get(id);
  const meta = await loadMeta(id);
  if (!meta) throw new Error(`Job ${id} no existe`);
  if (meta.status !== 'running' && meta.status !== 'starting') {
    return { cancelled: false, reason: `El job ya está en estado "${meta.status}", no se puede cancelar.` };
  }
  if (!child) {
    return {
      cancelled: false,
      reason: 'El proceso no está en memoria de este server (probablemente se lanzó en otra sesión del MCP). No se puede matar desde acá — hacelo a mano con el pid si sigue vivo: ' + (meta.pid ?? '?'),
    };
  }
  child.kill('SIGTERM');
  await updateJob(id, { status: 'cancelled', endedAt: new Date().toISOString() });
  return { cancelled: true };
}

export async function jobSummary(id, tailN = DEFAULT_TAIL_LINES) {
  const meta = await loadMeta(id);
  if (!meta) throw new Error(`Job ${id} no existe`);
  const log = await readLog(id);
  const durationMs = meta.endedAt
    ? new Date(meta.endedAt) - new Date(meta.startedAt)
    : Date.now() - new Date(meta.startedAt);
  return {
    ...meta,
    durationSeconds: Math.round(durationMs / 1000),
    tail: tailLines(log, tailN),
    totalLogLines: log ? log.split('\n').length : 0,
  };
}

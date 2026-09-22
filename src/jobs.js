import path from 'node:path';
import fsp from 'node:fs/promises';
import { JOBS_DIR, newId, nowIso, ensureDir, readFileIfExists, existsSync } from './util.js';

/**
 * Un "job" es UNA corrida de cursor-agent. Vive en disco en
 * `.jobs/<id>/{meta.json,output.log}` — sobrevive a un reinicio del server
 * MCP (podés preguntar por un job de una sesión anterior), aunque cancelar
 * (`job_cancel`) solo funciona mientras el proceso del server que lo lanzó
 * sigue vivo (el handle del child process es en memoria).
 */

// job_id -> ChildProcess, solo para los jobs lanzados por ESTE proceso.
export const liveProcesses = new Map();

function jobDir(id) {
  return path.join(JOBS_DIR, id);
}

export async function createJob({ label, cwd, worktreePath, branch, repoPath, command, promptPreview }) {
  const id = newId();
  const dir = jobDir(id);
  await ensureDir(dir);
  const meta = {
    id,
    label: label || null,
    cwd,
    worktreePath: worktreePath || null,
    branch: branch || null,
    repoPath: repoPath || null,
    command,
    promptPreview: promptPreview || null,
    pid: null,
    status: 'starting', // starting -> running -> done | failed | cancelled
    exitCode: null,
    startedAt: nowIso(),
    endedAt: null,
  };
  await saveMeta(id, meta);
  return meta;
}

export async function saveMeta(id, meta) {
  await fsp.writeFile(path.join(jobDir(id), 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

export async function loadMeta(id) {
  const raw = await readFileIfExists(path.join(jobDir(id), 'meta.json'));
  if (!raw) return null;
  return JSON.parse(raw);
}

export function logPath(id) {
  return path.join(jobDir(id), 'output.log');
}

export async function readLog(id) {
  return (await readFileIfExists(logPath(id))) ?? '';
}

export async function updateJob(id, patch) {
  const meta = await loadMeta(id);
  if (!meta) throw new Error(`Job ${id} no existe`);
  const updated = { ...meta, ...patch };
  await saveMeta(id, updated);
  return updated;
}

export async function listJobs({ repoPath, status, limit = 50 } = {}) {
  if (!existsSync(JOBS_DIR)) return [];
  const ids = await fsp.readdir(JOBS_DIR);
  const jobs = [];
  for (const id of ids) {
    const meta = await loadMeta(id);
    if (!meta) continue;
    if (repoPath && meta.repoPath !== repoPath) continue;
    if (status && meta.status !== status) continue;
    jobs.push(meta);
  }
  jobs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)); // más nuevo primero
  return jobs.slice(0, limit);
}

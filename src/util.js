import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

export const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const JOBS_DIR = path.join(PROJECT_ROOT, '.jobs');
export const DEFAULT_WORKTREES_DIR = path.join(os.homedir(), '.cursor-worktrees');
export const DEFAULT_TAIL_LINES = 30;

export function nowIso() {
  return new Date().toISOString();
}

/** ID corto, ordenable por tiempo: 20260922-031045-a1b2c3 */
export function newId() {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const rand = randomBytes(3).toString('hex');
  return `${ts}-${rand}`;
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * Corre un comando y devuelve {code, stdout, stderr}. Sin shell: los args van
 * como array, así que nada de escapar comillas/backticks a mano.
 */
export function runCapture(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Entorno con lo que carga la shell de login del usuario (PATH de
 * ~/.local/bin, CURSOR_API_KEY de ~/.zshrc, etc.) — se resuelve UNA vez por
 * proceso del server y se cachea. `cursor-agent` y `git` corren luego con
 * `spawn(cmd, argsArray, {env})` directo, sin shell — cero riesgo de
 * inyección por comillas/backticks/$ en el prompt.
 */
let cachedShellEnv = null;
export async function getShellEnv() {
  if (cachedShellEnv) return cachedShellEnv;
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const { code, stdout } = await runCapture(shell, ['-lc', 'env -0'], { env: process.env });
    if (code === 0 && stdout) {
      const env = { ...process.env };
      for (const pair of stdout.split('\0')) {
        if (!pair) continue;
        const idx = pair.indexOf('=');
        if (idx === -1) continue;
        env[pair.slice(0, idx)] = pair.slice(idx + 1);
      }
      cachedShellEnv = env;
      return env;
    }
  } catch {
    // sigue con process.env tal cual si la shell de login falla
  }
  cachedShellEnv = { ...process.env };
  return cachedShellEnv;
}

export function tailLines(text, n = DEFAULT_TAIL_LINES) {
  const lines = text.split('\n');
  if (lines.length <= n) return lines.join('\n');
  return lines.slice(-n).join('\n');
}

export function sliceLines(text, offset = 0, limit = 200) {
  const lines = text.split('\n');
  return lines.slice(offset, offset + limit).join('\n');
}

export function countLines(text) {
  if (!text) return 0;
  return text.split('\n').length;
}

export async function readFileIfExists(p) {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export function existsSync(p) {
  return fs.existsSync(p);
}

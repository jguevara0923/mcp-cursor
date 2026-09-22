import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { runCapture, getShellEnv, DEFAULT_WORKTREES_DIR } from './util.js';

async function git(repoPath, args, envOverride) {
  const env = envOverride || (await getShellEnv());
  const { code, stdout, stderr } = await runCapture('git', ['-C', repoPath, ...args], { env });
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

function slugifyBranch(branch) {
  return branch.replace(/[\\/]/g, '-');
}

export async function createWorktree({
  repoPath,
  branch,
  base = 'origin/main',
  worktreePath,
  linkNodeModules = true,
  fetch = true,
}) {
  const env = await getShellEnv();

  const check = await git(repoPath, ['rev-parse', '--is-inside-work-tree'], env);
  if (check.code !== 0) {
    throw new Error(`"${repoPath}" no es un repo git (o no existe): ${check.stderr}`);
  }

  if (fetch) {
    const remote = base.includes('/') ? base.split('/')[0] : 'origin';
    await git(repoPath, ['fetch', remote], env); // best-effort, no revienta si falla (ej. sin red)
  }

  const repoName = path.basename(repoPath);
  const finalPath = worktreePath || path.join(DEFAULT_WORKTREES_DIR, `${repoName}--${slugifyBranch(branch)}`);

  if (fs.existsSync(finalPath)) {
    throw new Error(`Ya existe algo en "${finalPath}" — pasá worktree_path distinto o limpiá con worktree_remove primero.`);
  }
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });

  const branchExists = await git(repoPath, ['rev-parse', '--verify', '--quiet', branch], env);
  const addArgs = branchExists.code === 0
    ? ['worktree', 'add', finalPath, branch] // la rama ya existe: no usar -b
    : ['worktree', 'add', finalPath, '-b', branch, base];

  const add = await git(repoPath, addArgs, env);
  if (add.code !== 0) {
    throw new Error(`git worktree add falló: ${add.stderr || add.stdout}`);
  }

  let nodeModulesLinked = false;
  if (linkNodeModules) {
    const src = path.join(repoPath, 'node_modules');
    const dst = path.join(finalPath, 'node_modules');
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      await fsp.symlink(src, dst, 'dir');
      nodeModulesLinked = true;
    }
  }

  return { worktreePath: finalPath, branch, base, repoPath, nodeModulesLinked };
}

export async function removeWorktree({ repoPath, worktreePath, deleteBranch = false, force = false }) {
  const env = await getShellEnv();
  const args = ['worktree', 'remove', worktreePath];
  if (force) args.push('--force');
  const rm = await git(repoPath, args, env);
  if (rm.code !== 0) {
    throw new Error(`git worktree remove falló: ${rm.stderr || rm.stdout}`);
  }
  let branchDeleted = null;
  if (deleteBranch) {
    // Necesita el nombre de rama — lo resuelve el caller y lo pasa aparte si quiere.
    branchDeleted = deleteBranch;
    await git(repoPath, ['branch', '-D', deleteBranch], env);
  }
  return { removed: worktreePath, branchDeleted };
}

export async function listWorktrees({ repoPath }) {
  const env = await getShellEnv();
  const { code, stdout, stderr } = await git(repoPath, ['worktree', 'list', '--porcelain'], env);
  if (code !== 0) throw new Error(`git worktree list falló: ${stderr}`);
  const entries = [];
  let current = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length), branch: null, head: null, bare: false, locked: false };
    } else if (line.startsWith('HEAD ')) {
      if (current) current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      if (current) current.branch = line.slice('branch '.length).replace('refs/heads/', '');
    } else if (line === 'bare') {
      if (current) current.bare = true;
    } else if (line.startsWith('locked')) {
      if (current) current.locked = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Diff completo del worktree (working tree vs su propio HEAD), INCLUYENDO
 * archivos nuevos sin trackear — vía `add -N` (intent-to-add: los mete al
 * índice SIN stagear contenido, solo para que aparezcan en el diff). No es
 * destructivo ni pisa nada del repo origen; es un worktree aislado.
 */
export async function diffWorktree({ worktreePath, statOnly = false, paths = [] }) {
  const env = await getShellEnv();
  await git(worktreePath, ['add', '-A', '-N', '--', ...(paths.length ? paths : ['.'])], env);
  const args = ['diff'];
  if (statOnly) args.push('--stat');
  if (paths.length) args.push('--', ...paths);
  const { code, stdout, stderr } = await git(worktreePath, args, env);
  if (code !== 0 && !stdout) throw new Error(`git diff falló: ${stderr}`);
  return stdout;
}

export async function statusWorktree({ worktreePath }) {
  const env = await getShellEnv();
  const { stdout } = await git(worktreePath, ['status', '--short'], env);
  return stdout;
}

/**
 * Trae el diff (uncommitted) del worktree al working tree del repo destino
 * (normalmente el repo "real" del usuario). Usa `git apply`, nunca `merge`/
 * `rebase` — no toca ramas ni historia del repo destino, solo el working tree
 * (y el índice si `stage: true`).
 */
export async function bringChanges({ worktreePath, targetRepoPath, paths = [], stage = false }) {
  const env = await getShellEnv();
  await git(worktreePath, ['add', '-A', '-N', '--', ...(paths.length ? paths : ['.'])], env);
  const diffArgs = ['diff', '--binary'];
  if (paths.length) diffArgs.push('--', ...paths);
  const { stdout: patch, code: diffCode, stderr: diffErr } = await git(worktreePath, diffArgs, env);
  if (diffCode !== 0 && !patch) throw new Error(`git diff falló: ${diffErr}`);
  if (!patch.trim()) return { applied: false, reason: 'El worktree no tiene cambios.', filesChanged: [] };

  const patchPath = path.join(worktreePath, `.bring-changes-${Date.now()}.patch`);
  await fsp.writeFile(patchPath, patch, 'utf8');
  try {
    const applyArgs = ['apply', '--whitespace=nowarn'];
    if (stage) applyArgs.push('--index');
    applyArgs.push(patchPath);
    const apply = await git(targetRepoPath, applyArgs, env);
    if (apply.code !== 0) {
      throw new Error(`git apply falló (nada se tocó en "${targetRepoPath}"): ${apply.stderr || apply.stdout}`);
    }
    const filesChanged = [...patch.matchAll(/^diff --git a\/(.+?) b\/.+$/gm)].map((m) => m[1]);
    return { applied: true, filesChanged, staged: stage };
  } finally {
    await fsp.unlink(patchPath).catch(() => {});
  }
}

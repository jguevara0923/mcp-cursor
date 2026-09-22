#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { readFileIfExists, runCapture, getShellEnv } from './util.js';
import { createWorktree, removeWorktree, listWorktrees, diffWorktree, statusWorktree, bringChanges } from './worktree.js';
import { launchJob, waitForJob, cancelJob, jobSummary } from './cursorRunner.js';
import { loadMeta, listJobs, readLog } from './jobs.js';
import { sliceLines, countLines } from './util.js';

const server = new McpServer({ name: 'cursor-agent', version: '1.0.0' });

function text(obj) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: 'text', text: body }] };
}

function errorText(err) {
  return { content: [{ type: 'text', text: `Error: ${err.message || String(err)}` }], isError: true };
}

async function resolvePrompt({ prompt, plan_file }) {
  if (prompt && prompt.trim()) return prompt;
  if (plan_file) {
    const content = await readFileIfExists(plan_file);
    if (content == null) throw new Error(`No pude leer plan_file: "${plan_file}"`);
    return content;
  }
  throw new Error('Falta "prompt" o "plan_file".');
}

function slugFromText(t, max = 40) {
  return t
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '') || 'plan';
}

function autoBranch(promptOrLabel) {
  const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  return `cursor/${slugFromText(promptOrLabel)}-${ts}`;
}

// =====================================================================
// check — diagnóstico rápido: ¿está cursor-agent instalado y logueado?
// =====================================================================
server.tool(
  'check',
  'Diagnóstico: verifica que el CLI `cursor-agent` esté instalado, su versión, y si CURSOR_API_KEY está disponible en el entorno de login shell. Corré esto primero si algo falla raro.',
  {},
  async () => {
    const env = await getShellEnv();
    const version = await runCapture('cursor-agent', ['--version'], { env });
    const which = await runCapture('which', ['cursor-agent'], { env });
    // El login real es una sesión persistida por `cursor-agent login` (no
    // necesariamente CURSOR_API_KEY) — `status` es la fuente de verdad.
    const status = await runCapture('cursor-agent', ['status'], { env });
    // "logged in" aparece como SUBSTRING de "Not logged in" — hay que
    // descartar explícitamente el caso negativo, no solo buscar la frase.
    const loggedIn = /logged in/i.test(status.stdout) && !/not\s+logged in/i.test(status.stdout);
    return text({
      installed: version.code === 0,
      version: version.stdout.trim() || null,
      path: which.stdout.trim() || null,
      loginStatus: status.stdout.trim() || status.stderr.trim() || null,
      loggedIn,
      cursorApiKeySet: Boolean(env.CURSOR_API_KEY),
      pathIncludesLocalBin: (env.PATH || '').includes('.local/bin'),
      hint: version.code !== 0
        ? 'cursor-agent no aparece en PATH — instalalo o agregá ~/.local/bin al PATH.'
        : !loggedIn
          ? 'No hay sesión activa — corré `cursor-agent login` a mano una vez (esto no lo puede hacer el MCP, es interactivo).'
          : 'Todo listo.',
    });
  }
);

server.tool(
  'list_models',
  'Lista los modelos disponibles para --model (ej. gpt-5, sonnet-4-thinking, claude-opus-4-8[...]).',
  {},
  async () => {
    const env = await getShellEnv();
    const { code, stdout, stderr } = await runCapture('cursor-agent', ['--list-models'], { env });
    if (code !== 0) return errorText(new Error(stderr || 'cursor-agent --list-models falló'));
    return text(stdout.trim());
  }
);

// =====================================================================
// WORKTREES
// =====================================================================
server.tool(
  'worktree_create',
  'Crea un git worktree aislado (+ rama nueva) para que cursor-agent trabaje sin tocar tu working directory actual. Hace `git fetch` del remoto de `base` primero. Si el repo es Node/TS, symlinkea node_modules del repo original (no reinstala nada).',
  {
    repo_path: z.string().describe('Ruta absoluta al repo git (ej. /Users/tu/Desktop/plaxp/frontend).'),
    branch: z.string().describe('Nombre de la rama nueva a crear para este trabajo.'),
    base: z.string().default('origin/main').describe('Punto de partida (default: origin/main).'),
    worktree_path: z.string().optional().describe('Ruta destino del worktree. Default: ~/.cursor-worktrees/<repo>--<rama>.'),
    link_node_modules: z.boolean().default(true).describe('Symlinkear node_modules del repo original (default: true).'),
    fetch: z.boolean().default(true).describe('Hacer `git fetch` del remoto de base antes de crear (default: true).'),
  },
  async (args) => {
    try {
      const result = await createWorktree({
        repoPath: args.repo_path,
        branch: args.branch,
        base: args.base,
        worktreePath: args.worktree_path,
        linkNodeModules: args.link_node_modules,
        fetch: args.fetch,
      });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  'worktree_list',
  'Lista los worktrees activos de un repo (rutas + rama + HEAD).',
  { repo_path: z.string() },
  async ({ repo_path }) => {
    try {
      return text(await listWorktrees({ repoPath: repo_path }));
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  'worktree_remove',
  'Elimina un worktree (y opcionalmente su rama). Usalo para limpiar después de traer los cambios con bring_changes, o para descartar un intento que no sirvió.',
  {
    repo_path: z.string().describe('Repo "dueño" del worktree.'),
    worktree_path: z.string(),
    delete_branch: z.string().optional().describe('Si se pasa, además borra esta rama con `git branch -D`.'),
    force: z.boolean().default(false).describe('Forzar aunque tenga cambios sin commitear (default: false — más seguro).'),
  },
  async (args) => {
    try {
      const result = await removeWorktree({
        repoPath: args.repo_path,
        worktreePath: args.worktree_path,
        deleteBranch: args.delete_branch,
        force: args.force,
      });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// =====================================================================
// RUN — job de cursor-agent en segundo plano
// =====================================================================
server.tool(
  'run',
  'Lanza cursor-agent con un prompt/plan en un directorio dado. Por DEFAULT es asíncrono: devuelve un job_id al toque y sigue corriendo en segundo plano (usá job_status/job_wait para seguirlo) — así podés lanzar varios en paralelo sin bloquear. Pasá wait:true si preferís esperar a que termine y recibir el resultado directo.',
  {
    cwd: z.string().describe('Directorio donde corre cursor-agent (normalmente un worktree_path de worktree_create).'),
    prompt: z.string().optional().describe('El plan/instrucción para cursor-agent. Alternativa a plan_file.'),
    plan_file: z.string().optional().describe('Ruta a un archivo de texto con el plan — mejor que `prompt` para planes largos (ahorra tokens en la llamada).'),
    model: z.string().optional().describe('Modelo a usar (si se omite, usa el default de cursor-agent).'),
    trust: z.boolean().default(true).describe('Agrega --trust (default: true, requerido para correr sin confirmar cada acción).'),
    force: z.boolean().default(true).describe('Agrega --force (default: true).'),
    output_format: z.string().default('text').describe('--output-format de cursor-agent (default: text).'),
    mode: z.enum(['agent', 'plan', 'ask']).default('agent').describe('"agent" (default) lee y escribe. "plan"/"ask" son de SOLO LECTURA — para pedir un análisis/plan sin que toque archivos.'),
    resume_chat_id: z.string().optional().describe('Continuar una sesión previa específica de cursor-agent (--resume <chatId>) en vez de arrancar una nueva.'),
    continue_session: z.boolean().default(false).describe('Continuar la última sesión de cursor-agent en este cwd (--continue). Ignorado si se pasa resume_chat_id.'),
    label: z.string().optional().describe('Etiqueta legible para identificar el job en job_list.'),
    branch: z.string().optional().describe('Solo metadata: qué rama es este trabajo (para job_list).'),
    repo_path: z.string().optional().describe('Solo metadata: repo dueño (para filtrar en job_list).'),
    wait: z.boolean().default(false).describe('Si true, bloquea hasta que termine (o timeout_seconds) y devuelve el resultado final.'),
    timeout_seconds: z.number().default(1800).describe('Solo si wait:true — máximo a esperar antes de devolver igual (el job sigue corriendo).'),
  },
  async (args) => {
    try {
      const prompt = await resolvePrompt(args);
      const meta = await launchJob({
        cwd: args.cwd,
        prompt,
        model: args.model,
        trust: args.trust,
        force: args.force,
        outputFormat: args.output_format,
        mode: args.mode,
        resumeChatId: args.resume_chat_id,
        continueSession: args.continue_session,
        label: args.label,
        branch: args.branch,
        repoPath: args.repo_path,
      });
      if (!args.wait) {
        return text({ ...meta, hint: `Corriendo en segundo plano. Usá job_status("${meta.id}") o job_wait("${meta.id}") para seguirlo.` });
      }
      const final = await waitForJob(meta.id, args.timeout_seconds);
      return text(await jobSummary(final.id));
    } catch (err) {
      return errorText(err);
    }
  }
);

// =====================================================================
// PLAN_RUN — worktree_create + run en un solo paso (el flujo típico)
// =====================================================================
server.tool(
  'plan_run',
  'Atajo todo-en-uno: crea el worktree Y lanza cursor-agent con el plan, en una sola llamada. Es el flujo recomendado para "dale este plan a Cursor". Async por default (wait:false) — devuelve worktree + job_id al toque.',
  {
    repo_path: z.string(),
    plan: z.string().optional().describe('El plan/instrucción. Alternativa a plan_file.'),
    plan_file: z.string().optional(),
    branch: z.string().optional().describe('Si se omite, se genera automático (cursor/<slug-del-plan>-<timestamp>).'),
    base: z.string().default('origin/main'),
    worktree_path: z.string().optional(),
    link_node_modules: z.boolean().default(true),
    model: z.string().optional(),
    mode: z.enum(['agent', 'plan', 'ask']).default('agent').describe('"agent" (default) lee y escribe. "plan"/"ask" son de SOLO LECTURA (útil para pedir un análisis antes de comprometerte a un worktree con escritura).'),
    label: z.string().optional(),
    wait: z.boolean().default(false),
    timeout_seconds: z.number().default(1800),
  },
  async (args) => {
    try {
      const prompt = await resolvePrompt({ prompt: args.plan, plan_file: args.plan_file });
      const branch = args.branch || autoBranch(args.label || prompt);
      const wt = await createWorktree({
        repoPath: args.repo_path,
        branch,
        base: args.base,
        worktreePath: args.worktree_path,
        linkNodeModules: args.link_node_modules,
      });
      const meta = await launchJob({
        cwd: wt.worktreePath,
        prompt,
        model: args.model,
        mode: args.mode,
        label: args.label,
        branch,
        repoPath: args.repo_path,
        worktreePath: wt.worktreePath,
      });
      if (!args.wait) {
        return text({
          worktree: wt,
          job: meta,
          hint: `Corriendo en "${wt.worktreePath}". Usá job_wait("${meta.id}") y después diff("${wt.worktreePath}") para revisar antes de bring_changes.`,
        });
      }
      const final = await waitForJob(meta.id, args.timeout_seconds);
      return text({ worktree: wt, job: await jobSummary(final.id) });
    } catch (err) {
      return errorText(err);
    }
  }
);

// =====================================================================
// PLAN_RUN_PARALLEL — multi-agente: varios worktrees + jobs a la vez
// =====================================================================
server.tool(
  'plan_run_parallel',
  'Despliega VARIOS agentes de cursor-agent en paralelo, cada uno en su propio worktree/rama. Ideal para tareas independientes (ej. "arreglar bug A" y "agregar feature B" al mismo tiempo, sin que se pisen). Cada tarea es como un plan_run individual.',
  {
    tasks: z.array(z.object({
      repo_path: z.string(),
      plan: z.string().optional(),
      plan_file: z.string().optional(),
      branch: z.string().optional(),
      base: z.string().default('origin/main'),
      worktree_path: z.string().optional(),
      link_node_modules: z.boolean().default(true),
      model: z.string().optional(),
      mode: z.enum(['agent', 'plan', 'ask']).default('agent'),
      label: z.string().optional(),
    })).min(1).describe('Una entrada por agente a desplegar.'),
    wait: z.boolean().default(false).describe('Si true, espera a que TODOS terminen antes de responder.'),
    timeout_seconds: z.number().default(1800),
  },
  async (args) => {
    const results = [];
    for (const task of args.tasks) {
      try {
        const prompt = await resolvePrompt({ prompt: task.plan, plan_file: task.plan_file });
        const branch = task.branch || autoBranch(task.label || prompt);
        const wt = await createWorktree({
          repoPath: task.repo_path,
          branch,
          base: task.base,
          worktreePath: task.worktree_path,
          linkNodeModules: task.link_node_modules,
        });
        const meta = await launchJob({
          cwd: wt.worktreePath,
          prompt,
          model: task.model,
          mode: task.mode,
          label: task.label,
          branch,
          repoPath: task.repo_path,
          worktreePath: wt.worktreePath,
        });
        results.push({ label: task.label || branch, worktree: wt, job: meta });
      } catch (err) {
        results.push({ label: task.label || task.branch || '?', error: err.message });
      }
    }
    if (args.wait) {
      const ids = results.filter((r) => r.job).map((r) => r.job.id);
      await Promise.all(ids.map((id) => waitForJob(id, args.timeout_seconds)));
      for (const r of results) {
        if (r.job) r.job = await jobSummary(r.job.id);
      }
    }
    return text({ launched: results.length, results });
  }
);

// =====================================================================
// JOBS — seguimiento
// =====================================================================
server.tool(
  'job_status',
  'Estado actual de un job: running/done/failed/cancelled, exit code, duración, y las últimas líneas del log (tail chico por default — para más, usá job_log).',
  {
    job_id: z.string(),
    tail_lines: z.number().default(30).describe('Cuántas líneas finales del log incluir (default: 30).'),
  },
  async ({ job_id, tail_lines }) => {
    try {
      return text(await jobSummary(job_id, tail_lines));
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  'job_wait',
  'Bloquea hasta que un job termine (o se cumpla timeout_seconds) y devuelve el resultado final con el log completo (o su tail). Usalo después de `run`/`plan_run` con wait:false cuando ya querés el resultado.',
  {
    job_id: z.string(),
    timeout_seconds: z.number().default(1800),
    tail_lines: z.number().default(60),
  },
  async ({ job_id, timeout_seconds, tail_lines }) => {
    try {
      const final = await waitForJob(job_id, timeout_seconds);
      return text(await jobSummary(final.id, tail_lines));
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  'job_log',
  'Trae una porción del log completo de un job, paginado por líneas — usalo cuando el tail de job_status no alcanza para diagnosticar algo. No devuelvas esto por default; solo cuando de verdad haga falta más detalle (consume más tokens que job_status).',
  {
    job_id: z.string(),
    offset_lines: z.number().default(0).describe('Desde qué línea empezar (0 = desde el inicio).'),
    limit_lines: z.number().default(200).describe('Cuántas líneas devolver como máximo.'),
    from_end: z.boolean().default(false).describe('Si true, offset/limit se cuentan desde el FINAL del log en vez del inicio.'),
  },
  async ({ job_id, offset_lines, limit_lines, from_end }) => {
    try {
      const log = await readLog(job_id);
      const total = countLines(log);
      const effectiveOffset = from_end ? Math.max(0, total - offset_lines - limit_lines) : offset_lines;
      return text({
        jobId: job_id,
        totalLines: total,
        offset: effectiveOffset,
        limit: limit_lines,
        text: sliceLines(log, effectiveOffset, limit_lines),
      });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  'job_list',
  'Lista jobs (más nuevos primero), opcionalmente filtrados por repo_path o status. Compacto — sin log, solo metadata.',
  {
    repo_path: z.string().optional(),
    status: z.enum(['starting', 'running', 'done', 'failed', 'cancelled']).optional(),
    limit: z.number().default(50),
  },
  async ({ repo_path, status, limit }) => {
    const jobs = await listJobs({ repoPath: repo_path, status, limit });
    return text(jobs.map(({ id, label, branch, status, startedAt, endedAt, exitCode, worktreePath }) => ({
      id, label, branch, status, startedAt, endedAt, exitCode, worktreePath,
    })));
  }
);

server.tool(
  'job_cancel',
  'Mata el proceso de un job que sigue corriendo (SIGTERM). Solo funciona si el job fue lanzado por ESTA sesión del server (el handle del proceso es en memoria).',
  { job_id: z.string() },
  async ({ job_id }) => {
    try {
      return text(await cancelJob(job_id));
    } catch (err) {
      return errorText(err);
    }
  }
);

// =====================================================================
// DIFF / BRING_CHANGES — revisar y traer los cambios de vuelta
// =====================================================================
server.tool(
  'diff',
  'Diff de lo que cursor-agent cambió en un worktree (incluye archivos nuevos). Usalo para REVISAR antes de bring_changes — no trae nada al repo, solo muestra.',
  {
    worktree_path: z.string(),
    stat_only: z.boolean().default(false).describe('true = solo el resumen (archivos + líneas +/-), sin el diff completo. Más barato en tokens.'),
    paths: z.array(z.string()).default([]).describe('Limitar el diff a estos paths (default: todo el worktree).'),
  },
  async (args) => {
    try {
      const diff = await diffWorktree({ worktreePath: args.worktree_path, statOnly: args.stat_only, paths: args.paths });
      const status = await statusWorktree({ worktreePath: args.worktree_path });
      return text({ status, diff: diff || '(sin cambios)' });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  'bring_changes',
  'Aplica los cambios (sin commitear) de un worktree al working tree de tu repo real, vía `git apply` — NUNCA hace merge/rebase de historia, solo mueve el diff. Revisá con `diff` primero. Si algo no aplica limpio, no toca nada y te devuelve el error de git tal cual.',
  {
    worktree_path: z.string(),
    target_repo_path: z.string().describe('Repo destino (normalmente tu working directory real del mismo proyecto).'),
    paths: z.array(z.string()).default([]).describe('Limitar a estos paths (default: todos los cambios del worktree).'),
    stage: z.boolean().default(false).describe('Si true, además deja los cambios en el índice (git add) — default false: solo working tree, para que vos decidas qué stagear.'),
  },
  async (args) => {
    try {
      const result = await bringChanges({
        worktreePath: args.worktree_path,
        targetRepoPath: args.target_repo_path,
        paths: args.paths,
        stage: args.stage,
      });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// =====================================================================
// HELP — cheatsheet compacto (para no releer el README cada vez)
// =====================================================================
server.tool(
  'help',
  'Cheatsheet compacto de este MCP: flujo típico, todas las herramientas y para qué sirve cada una. Llamá esto si no te acordás cómo se usa — más barato que leer el README completo.',
  {},
  async () => text(`cursor-agent-mcp — orquesta cursor-agent con worktrees aislados y jobs en segundo plano.

FLUJO TÍPICO (un solo agente):
  1. plan_run({repo_path, plan, label}) -> {worktree, job}   # crea worktree + lanza cursor-agent
  2. job_wait({job_id}) o job_status({job_id}) hasta status="done"
  3. diff({worktree_path, stat_only:true}) -> revisar qué cambió
  4. diff({worktree_path}) -> revisar el diff completo si hace falta
  5. bring_changes({worktree_path, target_repo_path}) -> aplica al repo real
  6. worktree_remove({repo_path, worktree_path, delete_branch: branch}) -> limpiar

MULTI-AGENTE (varias tareas independientes a la vez):
  plan_run_parallel({tasks:[{repo_path,plan,label}, {repo_path,plan,label}, ...]})
  -> luego job_wait / diff / bring_changes por cada uno.

HERRAMIENTAS:
  check                 diagnóstico: cursor-agent instalado, versión, API key
  worktree_create        crea worktree + rama aislados
  worktree_list          lista worktrees de un repo
  worktree_remove        borra un worktree (y opcional su rama)
  run                    lanza cursor-agent en un cwd dado (primitivo bajo nivel)
  plan_run               worktree_create + run en un paso (RECOMENDADO)
  plan_run_parallel      plan_run varias veces, en paralelo (multi-agente)
  job_status             estado + tail corto del log
  job_wait               bloquea hasta que termine
  job_log                log completo, paginado (solo si job_status no alcanza)
  job_list               lista jobs, filtrable por repo/status
  job_cancel             mata un job que sigue corriendo
  diff                   diff del worktree (para revisar antes de traer)
  bring_changes          aplica el diff del worktree a tu repo real (git apply)
  help                   este cheatsheet

Por default TODO lo async (run/plan_run/plan_run_parallel) NO espera — devuelve
un job_id al toque para que puedas seguir trabajando o lanzar más agentes en
paralelo. Pasá wait:true si preferís bloquear y recibir el resultado directo.

Los jobs quedan en disco en .jobs/<id>/{meta.json,output.log} — sobreviven un
reinicio del server (podés preguntar por jobs de sesiones anteriores con
job_status/job_log), pero job_cancel solo funciona en la sesión que lo lanzó.`)
);

const transport = new StdioServerTransport();
await server.connect(transport);

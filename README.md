<div align="center">

# cursor-agent-mcp

**El puente entre Claude Code y `cursor-agent`** — worktrees aislados, jobs en segundo plano, multi-agente en paralelo, y traer los cambios de vuelta a tu repo con `diff` / `bring_changes`.

[![Claude Code](https://img.shields.io/badge/Claude_Code-orquestador-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
[![cursor-agent](https://img.shields.io/badge/cursor--agent-CLI-000000?logo=cursor&logoColor=white)](https://cursor.com)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518.17-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-stdio-6a48bf?logo=modelcontextprotocol&logoColor=white)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

---

Reemplaza este flujo manual:

```bash
export PATH="$HOME/.local/bin:$PATH"
git worktree add <ruta-temporal> -b <rama> origin/main
cd <ruta-temporal> && ln -s <repo>/node_modules node_modules
cursor-agent -p --trust --force "<plan>" --output-format text
# ... revisar git diff, y recién ahí traer los cambios ...
```

...por 4-5 llamadas a herramientas MCP. Los logs largos y el texto del plan
quedan en disco, no metidos en la conversación.

## Índice

- [Instalación](#instalación)
- [Por qué existe](#por-qué-existe)
- [El flujo](#el-flujo)
- [Ejemplo real](#ejemplo-real)
- [Herramientas](#herramientas)
- [Diseño y límites](#diseño-y-límites)

## Instalación

```bash
git clone https://github.com/jguevara0923/mcp-cursor.git ~/Desktop/mcps/cursor-agent-mcp
curl https://cursor.com/install -fsS | bash   # si no tenés el CLI de Cursor
cursor-agent login                            # interactivo, una sola vez
cd ~/Desktop/mcps/cursor-agent-mcp && npm install
claude mcp add cursor-agent -- node ~/Desktop/mcps/cursor-agent-mcp/src/server.js
```

Verificar:

```bash
claude mcp list          # debe aparecer "cursor-agent"
node test/smoke-test.mjs # prueba rápida, no gasta cuota
```

Las herramientas aparecen como `mcp__cursor-agent__<nombre>` (ej.
`mcp__cursor-agent__plan_run`).

Para actualizar más adelante: `git pull && npm install` — no hace falta
volver a registrar el MCP.

| Requisito | Chequeo |
|---|---|
| Node.js ≥ 18.17 | `node --version` |
| Git ≥ 2.5 | `git --version` |
| `cursor-agent` logueado | `cursor-agent status` |

## Por qué existe

- **Aislamiento real**: cursor-agent nunca toca tu working directory — corre en un `git worktree` aparte, con su propia rama.
- **No bloquea**: lanzar un agente devuelve un `job_id` al toque. Podés lanzar varios en paralelo y seguir trabajando.
- **Ahorra tokens**: por default solo ves un tail corto del log (~30 líneas). El log completo vive en disco.
- **Revisar antes de traer**: `diff` muestra qué cambió sin tocar nada; `bring_changes` recién ahí aplica el diff con `git apply` (nunca merge/rebase).

## El flujo

```mermaid
flowchart LR
    A["Vos + Claude Code\narmás el plan"] -->|"plan_run(repo, plan)"| B["cursor-agent\nComposer, etc."]
    B -->|"corre en su propio\nworktree + rama"| C["Worktree aislado\ntu repo NO se toca"]
    C -.->|"diff() — revisá qué cambió"| A
    C -->|"bring_changes()\nrecién ahí se aplica"| D["Tu repo real"]

    style A fill:#D97757,stroke:#3a3a3a,color:#fff
    style B fill:#111111,stroke:#3a3a3a,color:#fff
    style C fill:#6a48bf,stroke:#3a3a3a,color:#fff
    style D fill:#2ea44f,stroke:#3a3a3a,color:#fff
```

## Ejemplo real

```jsonc
// 1. Lanzar (repo_path real, no placeholder)
plan_run({
  "repo_path": "/Users/joseguevara/Desktop/plaxp/backend",
  "plan": "Agregar GET /api/reportes/compras/historico-por-producto/resumen, patrón hexagonal de reportes-compras",
  "label": "historico-compras-resumen"
})
// -> { worktree: { worktreePath: "...", branch: "cursor-historico-compras-resumen-..." },
//      job: { id: "20260922-031501-a1b2c3", status: "starting" } }

// 2. Esperar
job_wait({ "job_id": "20260922-031501-a1b2c3" })
// -> { status: "done", exitCode: 0, tail: "...últimas líneas del log..." }

// 3. Revisar (barato en tokens)
diff({ "worktree_path": "...", "stat_only": true })
// -> " .../get-historico-compras-por-producto.use-case.ts | 45 +++++++"

// 4. Traer, si se ve bien
bring_changes({ "worktree_path": "...", "target_repo_path": "/Users/joseguevara/Desktop/plaxp/backend" })

// 5. Limpiar
worktree_remove({ "repo_path": "/Users/joseguevara/Desktop/plaxp/backend", "worktree_path": "...", "delete_branch": "cursor-historico-compras-resumen-..." })
```

**Multi-agente** (tareas independientes en paralelo, cada una en su propio worktree — nunca se pisan):

```jsonc
plan_run_parallel({
  "tasks": [
    { "repo_path": "/Users/joseguevara/Desktop/plaxp/frontend", "label": "fix-producto-autocomplete", "plan": "..." },
    { "repo_path": "/Users/joseguevara/Desktop/plaxp/frontend", "label": "chart-comparativo-costos", "plan": "..." }
  ]
})
// -> { launched: 2, results: [{ label, worktree, job }, { label, worktree, job }] }
```

## Herramientas

Llamá `help` para un cheatsheet corto sin salir de la conversación.

| Herramienta | Qué hace |
|---|---|
| `check` | Diagnóstico: cursor-agent instalado, versión, sesión logueada. |
| `list_models` | Modelos disponibles para `model`. |
| `worktree_create` | Worktree + rama nueva desde `base` (default `origin/main`). Symlinkea `node_modules`. |
| `worktree_list` / `worktree_remove` | Listar / borrar worktrees. |
| `run` | Primitivo: corre cursor-agent en un `cwd`. Async por default. |
| `plan_run` | `worktree_create` + `run` en un paso — el que usás normalmente. |
| `plan_run_parallel` | `plan_run` varias veces a la vez, un worktree por tarea. |
| `job_status` | Estado + tail corto del log. |
| `job_wait` | Bloquea hasta que el job termine. |
| `job_log` | Log completo, paginado — solo si `job_status` no alcanza. |
| `job_list` / `job_cancel` | Listar jobs / matar uno que sigue corriendo. |
| `diff` | Qué cambió en el worktree (`stat_only:true` = solo resumen). |
| `bring_changes` | Aplica el diff a tu repo real con `git apply`. No comitea. |
| `help` | Cheatsheet de todo esto. |

Parámetros más usados de `run` / `plan_run` / `plan_run_parallel`: `plan` o
`plan_file` (mejor para planes largos), `model`, `mode` (`agent` lee y
escribe; `plan`/`ask` son solo lectura), `wait` (default `false` — async),
`label`.

## Diseño y límites

- Los argumentos de `cursor-agent`/`git` van siempre como array a `spawn()`, nunca como string armado a mano — el plan puede traer comillas o `$` sin riesgo.
- El entorno pasa una vez por una shell de login (cacheado) para heredar `PATH`/variables de `~/.zshrc`.
- `bring_changes` usa `git apply`, nunca merge/rebase. Si el patch no aplica limpio, no toca nada.
- `cursor-agent` tiene worktrees nativos (`-w`/`--worktree-base`); este MCP usa los suyos propios para controlar el `base`, la ruta y el symlink de `node_modules`.
- `job_cancel` solo funciona en la sesión del server que lanzó ese job (el proceso vive en memoria, no en disco).
- Sin límite propio de jobs concurrentes — usá criterio con tu cuota de Cursor.
- `.jobs/` crece con cada corrida; borrala entera si se hace grande (no afecta jobs en curso).

## Estructura

```
cursor-agent-mcp/
  src/
    server.js          # registro de herramientas MCP
    cursorRunner.js     # arma args y lanza cursor-agent
    jobs.js             # persistencia en .jobs/<id>/
    worktree.js          # worktree add/remove/list + diff + bring_changes
    util.js              # shell env cacheado, helpers
  test/
    smoke-test.mjs       # sin gastar cuota
    e2e-test.mjs          # flujo completo en repo descartable
  .jobs/                  # (se crea solo) logs y metadata
```

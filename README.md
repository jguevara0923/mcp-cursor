# cursor-agent-mcp

**MCP server para orquestar `cursor-agent` desde Claude Code** — worktrees
aislados, jobs en segundo plano, multi-agente en paralelo, y traer los
cambios de vuelta a tu repo con `diff`/`bring_changes`.

Node ≥ 18.17 · sin dependencias raras (`@modelcontextprotocol/sdk` + `zod`) · MIT-para-vos (uso personal)

---

Le da a Claude Code (o cualquier cliente MCP) control total sobre
`cursor-agent`: crear worktrees de git aislados, lanzar agentes en segundo
plano, correr varios a la vez, revisar el diff y traer los cambios de vuelta
a tu repo real — todo sin que Claude tenga que escribir comandos de shell a
mano ni leer logs enteros.

Es la versión "hecha herramienta" del flujo que ya usaba manualmente:

```bash
export PATH="$HOME/.local/bin:$PATH"
git worktree add <ruta-temporal> -b <rama> origin/main
cd <ruta-temporal> && ln -s <repo>/node_modules node_modules
cursor-agent -p --trust --force "<plan>" --output-format text
# ... revisar git diff, y recién ahí traer los cambios ...
```

Con este MCP, todo eso son 4-5 llamadas a herramientas, con el trabajo
pesado (logs largos, texto del prompt) guardado en disco en vez de metido en
la conversación.

## Índice

- [Instalación rápida](#instalación-rápida) — copiá y pegá, 5 pasos
- [¿Por qué existe?](#por-qué-existe)
- [Requisitos](#requisitos)
- [Probar que quedó bien](#probar-que-quedó-bien)
- [El flujo típico](#el-flujo-típico)
- [Ejemplos reales](#ejemplo-real-una-tarea) (una tarea / multi-agente)
- [Referencia de herramientas](#referencia-de-herramientas)
- [Cómo se mantienen bajos los tokens](#cómo-se-mantienen-bajos-los-tokens)
- [Notas de diseño](#notas-de-diseño--decisiones)
- [Límites conocidos](#límites-conocidos)
- [Estructura del proyecto](#estructura-del-proyecto)

## Instalación rápida

Cinco pasos, de cero a listo (en esta máquina ya está clonado en
`~/Desktop/mcps/cursor-agent-mcp` — si estás en otra, empezá por el clone):

```bash
# 1. Cloná este repo
git clone https://github.com/jguevara0923/mcp-cursor.git ~/Desktop/mcps/cursor-agent-mcp

# 2. Instalá el CLI de Cursor, si no lo tenés
curl https://cursor.com/install -fsS | bash

# 3. Logueate (interactivo, una sola vez — el MCP no puede hacer esto por vos)
cursor-agent login

# 4. Instalá las dependencias del MCP
cd ~/Desktop/mcps/cursor-agent-mcp && npm install

# 5. Registralo en Claude Code
claude mcp add cursor-agent -- node ~/Desktop/mcps/cursor-agent-mcp/src/server.js
```

Confirmá que quedó enchufado:

```bash
claude mcp list          # debería aparecer "cursor-agent"
node test/smoke-test.mjs # prueba rápida, sin gastar cuota de cursor-agent
```

Las herramientas van a aparecer en Claude Code como
`mcp__cursor-agent__<nombre>` (ej. `mcp__cursor-agent__plan_run`). Listo —
saltá a [El flujo típico](#el-flujo-típico) para el primer uso real (con
rutas reales de mi setup, no genéricas), o seguí leyendo para el detalle de
cada paso.

> `claude mcp add` sin flags queda en tu config de **usuario** (todas tus
> sesiones de Claude Code lo ven). Si preferís que aplique solo a un proyecto
> puntual, corré el mismo comando desde ese directorio agregando
> `--scope project`.

### Actualizar a la última versión

Cuando este repo tenga cambios nuevos en GitHub:

```bash
cd ~/Desktop/mcps/cursor-agent-mcp && git pull && npm install
```

No hace falta volver a correr `claude mcp add` — Claude Code relanza el
server en cada sesión, así que toma el código actualizado solo.

## ⚡ ¿Por qué existe?

- **Aislamiento real**: cursor-agent nunca toca tu working directory actual.
  Trabaja en un `git worktree` aparte, con su propia rama.
- **No bloquea**: lanzar un agente devuelve un `job_id` al toque. Podés
  lanzar 3, 5, 10 en paralelo (cada uno en su propio worktree) y seguir
  trabajando mientras corren.
- **Ahorra tokens**: por default solo ves un resumen corto (últimas ~30
  líneas de log). El log completo existe en disco y lo pedís explícito
  (`job_log`) solo si de verdad hace falta.
- **Revisar antes de traer**: `diff` te muestra qué cambió sin tocar nada;
  `bring_changes` recién ahí aplica el diff a tu repo real, con `git apply`
  (nunca merge/rebase — no toca historia).

## Requisitos

| Qué | Versión | Chequeo rápido |
|---|---|---|
| Node.js | ≥ 18.17 | `node --version` |
| Git | ≥ 2.5 (por `git worktree`) | `git --version` |
| `cursor-agent` CLI | instalado + logueado | `cursor-agent status` |

Si `cursor-agent status` no dice "Logged in", corré `cursor-agent login`
(interactivo — no lo puede hacer el MCP por vos). La herramienta `check`
(dentro de Claude Code, una vez instalado) te da este mismo diagnóstico sin
salir de la conversación.

## Probar que quedó bien

```bash
node test/smoke-test.mjs   # rápido: lista de tools + check — NO gasta cuota
node test/e2e-test.mjs     # completo: crea un repo descartable en /tmp,
                            # corre worktree_create -> run -> diff ->
                            # bring_changes -> worktree_remove, y limpia todo
```

Si `cursor-agent` no tiene sesión activa, el paso `run` del segundo test va
a fallar con "Authentication required" — es esperado (`cursor-agent login`
lo arregla); el resto igual valida que el server en sí está bien armado.

## El flujo típico

```
┌──────────────────────┐   plan_run(repo_path, plan)   ┌───────────────────┐   corre en su propio    ┌────────────────────────┐
│  Vos + Claude Code    │ ─────────────────────────────▶│    cursor-agent    │──────────────────────▶ │   Worktree aislado      │
│  armás el plan acá    │                               │  (Composer, etc.)  │   worktree + rama       │  (tu repo NO se toca)   │
└──────────────────────┘                                └───────────────────┘                         └────────────────────────┘
           ▲                                                                                                       │
           │                     diff({worktree_path})  →  revisá qué cambió, sin tocar nada                       │
           └───────────────────────────────────────────────────────────────────────────────────────────────────────┘
                             bring_changes({worktree_path, target_repo_path})  →  RECIÉN ahí se aplica a tu repo real
```

Paso a paso, con las herramientas:

```
plan_run({ repo_path, plan, label })
        │
        ├─▶ crea worktree + rama nueva (git worktree add ... origin/main)
        └─▶ lanza cursor-agent en ese worktree, en segundo plano
        │
        ▼
   { worktree: {...}, job: { id, status: "running", ... } }

job_wait({ job_id })                       # esperar a que termine
        │
        ▼
diff({ worktree_path, stat_only: true })   # ver QUÉ cambió, resumido
diff({ worktree_path })                    # ver el diff completo si hace falta
        │
        ▼
bring_changes({ worktree_path, target_repo_path })   # aplicar a tu repo real
        │
        ▼
worktree_remove({ repo_path, worktree_path, delete_branch: "<rama>" })  # limpiar
```

### Ejemplo real (una tarea, con mis propias rutas)

> "Dale este plan a Cursor: en `plaxp/backend`, agregar un endpoint
> `GET /api/reportes/compras/historico-por-producto/resumen` que devuelva la
> última compra por proveedor de un producto, siguiendo el patrón hexagonal
> ya usado en `reportes-compras`."

```jsonc
// 1. Lanzar — repo_path es MI repo real, no un placeholder
plan_run({
  "repo_path": "/Users/joseguevara/Desktop/plaxp/backend",
  "plan": "Agregar GET /api/reportes/compras/historico-por-producto/resumen ... (plan completo acá)",
  "label": "historico-compras-resumen"
})
// -> { worktree: { worktreePath: "/Users/joseguevara/.cursor-worktrees/backend--cursor-historico-compras-resumen-20260922031500",
//                   branch: "cursor-historico-compras-resumen-20260922031500" },
//      job: { id: "20260922-031501-a1b2c3", status: "starting" } }

// 2. Esperar
job_wait({ "job_id": "20260922-031501-a1b2c3" })
// -> ver el JSON completo del resultado más abajo

// 3. Revisar (resumen primero — barato en tokens)
diff({ "worktree_path": "/Users/joseguevara/.cursor-worktrees/backend--cursor-historico-compras-resumen-20260922031500", "stat_only": true })
// -> " src/modules/reportes-compras/.../get-historico-compras-por-producto.use-case.ts | 45 +++++++
//      src/modules/reportes-compras/.../reportes-compras.controller.ts                | 20 +++"

// 4. Traer (si se ve bien)
bring_changes({
  "worktree_path": "/Users/joseguevara/.cursor-worktrees/backend--cursor-historico-compras-resumen-20260922031500",
  "target_repo_path": "/Users/joseguevara/Desktop/plaxp/backend"
})

// 5. Limpiar
worktree_remove({
  "repo_path": "/Users/joseguevara/Desktop/plaxp/backend",
  "worktree_path": "/Users/joseguevara/.cursor-worktrees/backend--cursor-historico-compras-resumen-20260922031500",
  "delete_branch": "cursor-historico-compras-resumen-20260922031500"
})
```

Lo que devuelve `job_wait` (`meta.json` + tail del log, ya armado por
`jobSummary`):

```jsonc
{
  "id": "20260922-031501-a1b2c3",
  "label": "historico-compras-resumen",
  "cwd": "/Users/joseguevara/.cursor-worktrees/backend--cursor-historico-compras-resumen-20260922031500",
  "branch": "cursor-historico-compras-resumen-20260922031500",
  "repoPath": "/Users/joseguevara/Desktop/plaxp/backend",
  "status": "done",                       // starting | running | done | failed | cancelled
  "exitCode": 0,
  "startedAt": "2026-09-22T03:15:01.000Z",
  "endedAt": "2026-09-22T03:16:40.000Z",
  "durationSeconds": 99,
  "totalLogLines": 214,                   // el log completo vive en disco — pedilo con job_log si hace falta
  "tail": "...últimas ~30 líneas del log, no las 214..."
}
```

### Ejemplo real (multi-agente, tareas independientes en paralelo)

> "Necesito que en paralelo, en `plaxp/frontend`: (A) arreglés que el
> selector de producto del reporte de histórico de compras no deje buscar
> otro sin perder la selección actual, y (B) agregués un gráfico de barras
> al reporte de Comparativo de Costos — son cosas que no se tocan entre sí."

```jsonc
plan_run_parallel({
  "tasks": [
    { "repo_path": "/Users/joseguevara/Desktop/plaxp/frontend", "label": "fix-producto-autocomplete",
      "plan": "En ProductoAutocomplete.tsx, buscar otro producto no debe borrar el actual hasta confirmar uno nuevo... (plan completo)" },
    { "repo_path": "/Users/joseguevara/Desktop/plaxp/frontend", "label": "chart-comparativo-costos",
      "plan": "Agregar un ChartCard con BarChart a ComparativoCostosReport.tsx, mismo patrón que ComprasPorProveedorReport... (plan completo)" }
  ]
})
// -> { launched: 2, results: [
//      { label: "fix-producto-autocomplete", worktree: {...}, job: { id: "...", status: "starting" } },
//      { label: "chart-comparativo-costos", worktree: {...}, job: { id: "...", status: "starting" } }
//    ]}
```

Cada tarea corre en SU PROPIO worktree/rama — nunca se pisan entre sí, ni con
tu working directory real, aunque toquen el mismo repo (acá, las dos tocan
`plaxp/frontend` al mismo tiempo sin chocar). Después seguís cada una con
`job_status`/`job_wait` + `diff` + `bring_changes` por separado.

## Referencia de herramientas

Llamá `help` en cualquier momento para un cheatsheet corto sin salir de la
conversación. Acá el detalle:

### Diagnóstico

| Herramienta | Qué hace |
|---|---|
| `check` | ¿Está `cursor-agent` instalado? ¿Qué versión? ¿Hay sesión logueada? Corré esto primero si algo falla. |
| `list_models` | Lista los modelos disponibles para el parámetro `model` (gpt-5, sonnet-4-thinking, etc.). |

### Worktrees (aislamiento)

| Herramienta | Qué hace |
|---|---|
| `worktree_create` | Crea un worktree + rama nueva. Hace `git fetch` del remoto de `base` primero. Symlinkea `node_modules` si existe (no reinstala nada). |
| `worktree_list` | Lista los worktrees activos de un repo. |
| `worktree_remove` | Borra un worktree (y opcionalmente su rama). |

Parámetros clave de `worktree_create`:
- `repo_path` (obligatorio) — el repo git.
- `branch` (obligatorio) — nombre de la rama nueva.
- `base` (default `origin/main`) — punto de partida.
- `worktree_path` (opcional) — default `~/.cursor-worktrees/<repo>--<rama>`.
- `link_node_modules` (default `true`).

### Ejecutar cursor-agent

| Herramienta | Qué hace |
|---|---|
| `run` | Primitivo de bajo nivel: corre cursor-agent en un `cwd` dado. Async por default. |
| `plan_run` | **El que usás normalmente**: `worktree_create` + `run` en un solo paso. |
| `plan_run_parallel` | `plan_run` varias veces a la vez — un worktree/job por tarea. |

Parámetros compartidos por los tres (todos con default sensato):

| Parámetro | Default | Qué es |
|---|---|---|
| `prompt` / `plan` | — | El texto del plan. Para planes largos, mejor `plan_file` (ruta a un .txt/.md) — así no metés un string gigante en la llamada. |
| `plan_file` | — | Alternativa a `prompt`/`plan`: leer el plan de un archivo. |
| `model` | el default de cursor-agent | Qué modelo usar (`list_models` para ver opciones). |
| `mode` | `"agent"` | `"agent"` lee y escribe. `"plan"`/`"ask"` son de **SOLO LECTURA** — para pedirle un análisis o un plan sin riesgo de que toque archivos. |
| `trust` | `true` | Agrega `--trust` (necesario para no confirmar cada acción). |
| `force` | `true` | Agrega `--force` (correr todo sin preguntar). |
| `wait` | `false` | `false` = devuelve `job_id` al toque y sigue en segundo plano. `true` = bloquea hasta terminar. |
| `timeout_seconds` | `1800` | Solo si `wait:true` — cuánto esperar como máximo. |
| `label` | — | Nombre legible para identificarlo después en `job_list`. |

Solo en `run` (para continuar una sesión ya existente en un worktree que
seguís usando):

| Parámetro | Qué es |
|---|---|
| `resume_chat_id` | Continuar una sesión específica (`--resume <id>`). |
| `continue_session` | Continuar la última sesión en ese `cwd` (`--continue`). |

### Seguir un job

| Herramienta | Qué hace |
|---|---|
| `job_status` | Estado + tail corto del log (rápido, barato en tokens). |
| `job_wait` | Bloquea hasta que termine (o timeout) y devuelve el resultado. |
| `job_log` | Log completo, **paginado por líneas** — solo cuando `job_status` no alcanza. |
| `job_list` | Lista jobs (nuevo primero), filtrable por `repo_path`/`status`. |
| `job_cancel` | Mata un job que sigue corriendo (solo si lo lanzó ESTA sesión del server). |

Los jobs quedan guardados en `.jobs/<id>/{meta.json,output.log}` dentro de
esta carpeta — sobreviven un reinicio del server MCP (podés preguntar por un
job de ayer con `job_status`), pero `job_cancel` solo funciona mientras el
proceso que lo lanzó sigue vivo.

### Revisar y traer los cambios

| Herramienta | Qué hace |
|---|---|
| `diff` | Diff de lo que cambió en el worktree (incluye archivos nuevos). `stat_only:true` para solo el resumen — más barato en tokens. |
| `bring_changes` | Aplica ese diff a tu repo real con `git apply`. Nunca toca historia (no es merge/rebase). Si algo no aplica limpio, no rompe nada y te devuelve el error de git tal cual. |

`bring_changes` no comitea por vos — deja los cambios en el working tree
(o en el índice, si pasás `stage:true`). Comitear queda en tus manos, a
propósito.

## 🪙 Cómo se mantienen bajos los tokens

1. **Todo async por default.** `run`/`plan_run`/`plan_run_parallel` devuelven
   un `job_id` al toque — el texto largo del prompt y el log entero NUNCA
   viajan de vuelta en la respuesta salvo que los pidas.
2. **`job_status` da un tail chico** (30 líneas por default), no el log
   entero. `job_log` (el completo, paginado) es un paso aparte, explícito.
3. **`diff` con `stat_only:true`** te da el resumen (archivos + líneas)
   antes de pedir el diff línea por línea completo.
4. **`plan_file` en vez de `prompt`** para planes largos — el archivo vive
   en disco, no en la conversación.
5. **`help` es un cheatsheet de una sola llamada** en vez de tener que leer
   este README entero cada vez que te olvidás un parámetro.

## Notas de diseño / decisiones

- **Sin shell para armar comandos**: los argumentos de `cursor-agent` y
  `git` se pasan siempre como array a `spawn(...)`, nunca como un string
  armado a mano — así el texto del plan puede traer comillas, backticks,
  `$`, lo que sea, sin riesgo de que se interprete como shell.
- **El entorno SÍ pasa por una shell de login** (`$SHELL -lc 'env -0'`),
  una sola vez, cacheado — para heredar `PATH` (`~/.local/bin`) y cualquier
  variable que vivan en tu `~/.zshrc`/`~/.zprofile`. Eso es lo único que usa
  shell; los comandos en sí, no.
- **`bring_changes` usa `git apply`, nunca `git merge`/`rebase`**: no toca
  ramas ni historia del repo destino, solo el working tree (y el índice si
  pedís `stage:true`). Si el patch no aplica limpio, no se aplica nada — no
  hay un estado a medias que limpiar.
- **`diffWorktree`/`bring_changes` usan `git add -N` (intent-to-add)** antes
  del diff, para que los archivos NUEVOS también aparezcan — sin eso,
  `git diff` solo muestra cambios a archivos ya trackeados. `-N` no
  stagea contenido, solo hace que el archivo entre al diff.
- **`cursor-agent` también tiene worktrees nativos** (`-w`/`--worktree`,
  `--worktree-base`) que crean el worktree en
  `~/.cursor/worktrees/<repo>/<nombre>`. Este MCP usa SU PROPIO manejo de
  worktrees en vez de esa flag porque necesita: elegir el `base` exacto
  (`origin/main` recién fetcheado), elegir la ruta, symlinkear
  `node_modules`, y poder listar/borrar worktrees de forma pareja sin
  depender de dónde los puso cursor-agent. Si algún día conviene simplificar
  usando la flag nativa, es una opción — documentado acá para que quede
  claro que fue decisión, no que no se sabía que existía.

## Límites conocidos

- `job_cancel` solo funciona en la sesión del server que lanzó ese job (el
  handle del proceso vive en memoria, no en disco). Si reiniciás Claude
  Code / el MCP y un job sigue corriendo, podés verlo con `job_status` pero
  no matarlo desde acá — hacelo a mano con el `pid` que te muestra.
- No hay límite de jobs concurrentes propio — si lanzás 50 en paralelo,
  corren 50 procesos de `cursor-agent` a la vez. Usá tu criterio (y fijate
  la cuota de tu plan de Cursor).
- `.jobs/` crece con el tiempo (un `meta.json` + `output.log` por corrida).
  No hay limpieza automática todavía — borrá la carpeta entera si se hace
  muy grande (no afecta nada en curso, los jobs activos siguen en memoria
  del proceso del server mientras corren).

## Estructura del proyecto

```
cursor-agent-mcp/
  package.json
  README.md
  .gitignore
  src/
    server.js          # registro de todas las herramientas MCP
    cursorRunner.js     # arma los args y lanza cursor-agent, escribe el log
    jobs.js             # persistencia de jobs en .jobs/<id>/
    worktree.js          # git worktree add/remove/list + diff + bring_changes
    util.js              # entorno de shell cacheado, helpers de texto
  test/
    smoke-test.mjs       # prueba rápida: lista de tools + check (no gasta cuota)
    e2e-test.mjs          # flujo completo contra un repo descartable en /tmp
  .jobs/                  # (se crea solo) logs y metadata de cada corrida
```

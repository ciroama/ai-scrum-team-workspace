# Architecture

One Node.js 22 process, plain JavaScript (ES modules), no runtime
dependencies, no build step.

```
Browser (public/)                         Node.js server (src/)
┌──────────────────────────────┐  REST   ┌────────────────────────────────────────────┐
│ Sidebar · Project header      │ ──────► │ server/app.js     JSON API, static files,  │
│ Product Workspace conversation│ ◄────── │                   Server-Sent Events       │
│ Team rail · Activity · Preview│   SSE   ├────────────────────────────────────────────┤
│ Team / Activity / Repository  │         │ core/orchestrator.js  (infrastructure)     │
└──────────────────────────────┘         │   checks availability before each stage   │
                                          │   asks the responsible agent to decide    │
                                          │   executes the work, records every event  │
                                          ├──────────────┬──────────────┬──────────────┤
                                          │ agents/      │ recipes/     │ actions/     │
                                          │ PO, Dev, QA  │ hello-world- │ writeFile    │
                                          │ (scripted)   │ web          │ runCommand   │
                                          │              │              │ tapParser    │
                                          │              │              │ git          │
                                          ├──────────────┴──────────────┴──────────────┤
                                          │ storage/  SQLite (node:sqlite)             │
                                          │ agent_config · workflows · tasks · events  │
                                          └────────────────────────────────────────────┘
                                                     │
                       data/workspace.db   data/workflows/<id>/product/  (own .git)
```

## People, agents and infrastructure

- **You (human)**: submit requirements, enable/disable agents, resume or
  cancel blocked workflows.
- **PO, Developer, QA**: the three agents. Each is `AgentKind.SCRIPTED` by
  default. The PO and the Developer can be switched to `AgentKind.AI`
  (Claude Code); QA is always scripted.
- **Orchestrator**: infrastructure. It makes no product decisions.

## Agent contracts (structured inputs and outputs)

| Agent | Method | Input | Output |
|---|---|---|---|
| PO | `analyse` | request text, recipe catalogue | `ready` + spec (requirements, acceptance criteria with machine-checkable checks, handoff message), or `needs_clarification` + message + supported types |
| PO | `review` | spec, QA verification record | accepted / not accepted, unmet criteria |
| Developer | `implement` | spec, attempt number, QA defects | files to write, summary, handoff message |
| QA | `planVerification` | spec, implemented files | acceptance test file, required files, commands |
| QA | `evaluate` | spec, recorded results (missing files, exit codes, parsed tests) | verdict, per-criterion results, defects, handoff or feedback message |

Agents only decide. The orchestrator writes files, runs commands, commits
and records events, so the event log shows what actually happened.

## Workflow state machine

```
analysis (PO) ──► implementation (Dev) ──► verification (QA) ──► review (PO) ──► completed / failed
     │                                        │   ▲
     └─► needs_clarification                  ▼   │  defects (max 3 implementation attempts)
                                            correction (Dev)
```

- Before every stage the orchestrator checks that the responsible agent is
  enabled. If not, the workflow becomes **blocked** at that stage. The reason
  is recorded and nothing after that point runs.
- **Resume** (only once the agent is enabled) continues from the saved stage
  using the saved state (`workflows.state`: spec, implementation, verification).
- Disabling an agent never interrupts a running task. The change applies to the
  next assignment, and the event says so.
- A workflow still marked running when the server starts is marked
  **interrupted**. Resume runs that stage again.
- **Verified** is set only when QA actually ran its checks with a pass verdict
  and the PO accepted the result.
- One workflow occupies the slot at a time (running or blocked).

## Events

Each event has: id, workflow id (or null for workspace-level configuration
changes made with no active workflow), timestamp, type, category, actor and
actor kind (human / scripted / system), from/to for handoffs, a readable
summary, structured detail (evidence), status, error, and task id.

| Category | Types |
|---|---|
| request | `request.submitted` |
| analysis | `task.started`, `po.requirements`, `po.clarification` |
| handoff | `handoff` (PO→Developer, Developer→QA, QA→Developer, QA→PO) |
| implementation / correction | `task.started`, `dev.implementation`, `dev.correction` |
| file | `file.written` (path, created/modified/unchanged, size, SHA-256) |
| command | `command.started`, `command.finished` (exit code, duration, output) |
| test | `qa.plan`, `qa.files`, `test.results`, `qa.verdict` |
| defect | `defect.reported` (criterion, expected, actual, evidence) |
| review | `po.review` |
| git | `git.commit`, `git.unavailable`, `git.failed` |
| config | `agent.enabled`, `agent.disabled` |
| workflow / completion / error | `workflow.created`, `.blocked`, `.resumed`, `.cancelled`, `.interrupted`, `.needs_clarification`, `.completed`, `.failed`, `task.failed` |

The conversation on the Home page shows the communication events (request,
PO outputs, handoffs, Developer and QA results, review, workflow notes). The
Team Activity page shows everything with evidence.

## Product repository isolation

Products live in `data/workflows/<id>/product/`, inside the dashboard
folder's Git-ignored `data/` directory. `src/actions/git.js` runs every Git
command with explicit `--git-dir=<product>/.git --work-tree=<product>` and
removes inherited `GIT_*` variables, so Git never searches parent folders and
cannot touch the dashboard repository. A test proves this against a real
outer repository. Commits use a local identity, signing and hooks are
disabled, and nothing is pushed. On macOS, Git availability is checked via
`xcode-select -p` first, so the dashboard never triggers Apple's installer
dialog.

## Live Preview

`src/preview/previewService.js` is a small static file server, separate from
the dashboard server and the orchestrator:

- It listens on its own port (127.0.0.1; automatic free port, or
  `PREVIEW_PORT`), so the product runs on a different origin than the
  dashboard. The dashboard embeds it in a sandboxed iframe (`allow-scripts`
  only).
- It serves exactly one product at a time, at
  `http://127.0.0.1:<port>/<workflowId>/<entry>`. Requests for any other
  workflow return 404, so the iframe can never show the wrong product. Hidden
  files (the product's `.git`) and paths outside the product folder are never
  served.
- Status: `not_started` → `starting` → `running` or `error`. It is `running`
  only after an HTTP GET of the entry page succeeded. A refresh re-checks it, so
  deleted files turn it into `error`.
- Concurrent start requests share one start, and there is never more than one
  server. Port conflicts and missing products are reported as `error` with the
  reason.
- Recipes declare how they are previewed (`preview: { type: 'static', entry:
  'index.html' }`). Future product types (a website, a Breakout game) can reuse
  the same panel, or add another preview type.

## Analytics

`src/analytics/analytics.js` computes statistics from
`Repository#analyticsSource()`: all workflows and tasks, plus the
`test.results`, `handoff`, `workflow.blocked`, `workflow.resumed` and
`workflow.cancelled` events. **No new event recording was needed.** Every
statistic below was already derivable from what the workspace records.

- **Project** = the workflow's `recipe_id` (stable, set by the PO).
  Workflows without one are "Unassigned". Every task and event belongs to one
  workflow, and every workflow to one project, so filtering by workflow ids
  cannot double count. "All Projects" is the union.
- **Recorded metrics:** workflow counts by status, tests passed/failed
  (sums of the recorded runs), correction cycles (QA → Developer feedback
  handoffs), blocks by disabled agents (with the agent), tasks per agent.
- **Calculated metrics:** success rate (verified ÷ (completed + failed)),
  average/median completion time of verified workflows (wall clock, including
  blocked time), average time blocked (block → next resume/cancel), agent
  execution time (finished tasks only; interrupted tasks excluded).
- Metrics with no supporting data return `null` and the page shows "Not enough
  data yet".
- **Not measured:** waiting time between handoffs (stages start immediately),
  agent idle time, Milestone 1 history.
- **Charts** use colours validated for the dark surface (single series
  `#0ea5c4`; outcomes green `#0b9a6a`, amber `#b98509`, neutral `#6b7891`,
  red `#dc4a4f`). Every bar is labelled with text and value, and has a hover
  tooltip.

## AI-powered agents (Claude Code)

The first AI integration used GitHub Models. That service was retired on
30 July 2026, so it was removed; any token it stored is deleted on start.

- `src/ai/claudeCode.js` runs the locally installed Claude Code once per
  request: `claude -p --output-format json --model <model> --system-prompt
  <...> --tools "" --strict-mcp-config --no-session-persistence`, with the
  user message on stdin, in an empty temporary folder. With no tools the
  model can only answer with text. Claude Code uses its own login (for
  example a Claude Pro subscription). `ANTHROPIC_API_KEY` and
  `ANTHROPIC_AUTH_TOKEN` are removed from the child environment, so a key in
  the environment can never turn this into paid API usage. The reply's
  `result`, `modelUsage` (model name), `usage` (tokens) and `duration_ms` are
  read from the printed JSON. Errors are typed as `AiUnavailableError`
  (`not_configured`, `auth`, `rate_limit`, `timeout`, `service`,
  `invalid_response`).
- `src/ai/aiSettings.js` keeps the model (default `sonnet`) and the last
  connection test in the local `settings` table. No credential is stored.
- `src/agents/roster.js` gives the orchestrator, for each role, the scripted
  or AI agent that matches `agent_config.mode`. Only the PO and the Developer
  have AI versions. **QA is always scripted.**
- `src/agents/ai/aiAgents.js`: the AI PO and AI Developer implement the same
  contracts as the scripted agents. `src/ai/contracts.js` validates every
  reply:
  - The PO may only use deterministic check types (`fileExists`,
    `fileContains`, `textVisible`, `htmlTitle`, `cssProperty`,
    `centeredLayout`). `index.html` is always required.
  - The Developer may only write relative, non-hidden files with allowed
    extensions, outside `test/`, without external URLs, and must include
    `index.html`.
  - An invalid reply is retried once with the problems listed, then the
    workflow blocks.
- The orchestrator treats errors marked `blocking` (AI unavailable, or a
  configuration mismatch such as AI PO + scripted Developer) as a
  **block with reason**, which can be resumed, not as a failure. Every
  model request becomes an `ai.call` event (model, purpose, attempt,
  duration, tokens, outcome). `workflow.blocked` events carry a `cause`
  (`agent_disabled`, `ai_unavailable`, `configuration`).
- AI products use the `ai-static-web` product type, which is previewed like
  any static site.
- Analytics counts disabled-agent blocks separately from AI/configuration
  blocks, and reports the AI requests and their token totals.

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | agents (config + activity), recipes, stages, workflows, git status |
| POST | `/api/workflows` | `{ "request": "..." }` → 201, or 400 (invalid) / 409 (busy) |
| GET | `/api/workflows/:id` | workflow, tasks, timeline, product files read from disk |
| POST | `/api/workflows/:id/resume` | resume a blocked/interrupted workflow |
| POST | `/api/workflows/:id/cancel` | cancel a blocked/interrupted workflow |
| PUT | `/api/agents/:id` | `{ "enabled": true \| false, "mode": "scripted" \| "ai" }` |
| GET / PUT | `/api/ai` | AI provider status / `{ "model": "sonnet" }` ("" restores the default) |
| POST | `/api/ai/test` | send one real test request to Claude Code |
| GET | `/api/preview` | Live Preview status |
| POST | `/api/preview` | `{ "workflowId": "..." }` start or switch the preview |
| POST | `/api/preview/refresh` | re-check (and reload) the current preview |
| POST | `/api/preview/stop` | stop the preview server |
| GET | `/api/analytics` | `?project=all\|<id>\|unassigned&from=<iso>&to=<iso>` |
| GET | `/api/stream` | Server-Sent Events: `workflow-event`, `change`, `preview` |

## Dashboard layout

Based on the reference screenshot: a left sidebar (Home, Projects, Team, Team
Activity, Repository), a project header, the Product Workspace conversation
with its stage tracker and request box, a right column with the AI Scrum
Team, compact Team Activity and a reserved **Live Preview** slot, and
shortcut cards. Responsive: three columns at 1280 px and wider, two columns
below that, one column below 960 px.

There is no Settings page, because the only configuration (agent
availability) is on the team cards. The sidebar also has an **Analytics**
page. The right column's **Live Preview** panel shows the running product.

## Compatibility choices (macOS 11, Intel, 8 GB)

- Node 22 LTS is the newest Node line that supports macOS 11.
- `node:sqlite` is built into Node ≥ 22.13: no native modules to compile. Its
  "experimental" warning is suppressed in the npm scripts.
- No Docker or Homebrew, since neither supports Big Sur any more.
- System fonts and inline SVG icons only: no network access at runtime.
- The browser code avoids features newer than Safari 16.
- The generated product uses classic scripts so `index.html` also works when
  opened directly from disk.

## Known limitations

- The scripted PO supports only the Hello World web application recipe. The
  AI-powered PO supports any static web page.
- AI quality depends on the model, and the Claude subscription has a usage
  limit that resets every few hours; when it is reached the workflow blocks. QA checks for static pages are deterministic but heuristic
  (for example "centred" accepts any common centring CSS; colours must match
  exactly after normalisation).
- Claude Code needs macOS 13 or newer, so on the macOS 11 Mac the workspace
  runs inside an Ubuntu virtual machine (UTM) and is opened from the Mac
  through an SSH tunnel. The automated tests use a stand-in `claude` command;
  `claude -p --output-format json` and `--model sonnet` were checked by hand
  in the VM before this integration was written.
- The scripted Developer produces correct code, so the correction loop does
  not occur in normal use. It is implemented and covered by automated tests
  that use a deliberately defective test double (never used by the app).
- An interrupted stage reruns from its start.
- Live Preview supports static products only (the only product type so far).
  The preview iframe is small; use "open in a new tab" for a full view.
- Analytics covers workflows recorded since the current schema. Execution times
  are real but short, because scripted agents finish in milliseconds.
- No code editor, no authentication, no Settings page.

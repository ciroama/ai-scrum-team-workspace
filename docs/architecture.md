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
- **PO, Developer, QA**: the three agents. All are `AgentKind.SCRIPTED` in this
  milestone. `AgentKind.AI` is reserved for future model-backed agents.
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

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | agents (config + activity), recipes, stages, workflows, git status |
| POST | `/api/workflows` | `{ "request": "..." }` → 201, or 400 (invalid) / 409 (busy) |
| GET | `/api/workflows/:id` | workflow, tasks, timeline, product files read from disk |
| POST | `/api/workflows/:id/resume` | resume a blocked/interrupted workflow |
| POST | `/api/workflows/:id/cancel` | cancel a blocked/interrupted workflow |
| PUT | `/api/agents/:id` | `{ "enabled": true \| false }` |
| GET | `/api/stream` | Server-Sent Events: `workflow-event`, `change` |

## Dashboard layout

Based on the reference screenshot: a left sidebar (Home, Projects, Team, Team
Activity, Repository), a project header, the Product Workspace conversation
with its stage tracker and request box, a right column with the AI Scrum
Team, compact Team Activity and a reserved **Live Preview** slot, and
shortcut cards. Responsive: three columns at 1280 px and wider, two columns
below that, one column below 960 px.

There is no Settings page, because the only configuration (agent
availability) is on the team cards. The Live Preview slot is reserved but not
implemented. A later preview can serve the product's `index.html` from the
product folder.

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

- Agents are scripted. Only the Hello World web application recipe exists.
- The scripted Developer produces correct code, so the correction loop does
  not occur in normal use. It is implemented and covered by automated tests
  that use a deliberately defective test double (never used by the app).
- An interrupted stage reruns from its start.
- No live preview, no code editor, no authentication, no Settings page.

# Architecture (Milestone 1)

One Node.js 22 process, plain JavaScript (ES modules), no runtime dependencies.

```
Browser dashboard (public/)            Node.js server (src/)
┌───────────────────────────┐   REST   ┌──────────────────────────────────────┐
│ Team · Backlog · History   │ ───────► │ server/app.js   HTTP + JSON API      │
│ Run steps · Events · Tests │ ◄─────── │                 Server-Sent Events   │
│ Files · Terminal           │   SSE    ├──────────────────────────────────────┤
└───────────────────────────┘          │ core/orchestrator.js                 │
                                        │   runs workflow steps in order       │
                                        │   asks agents what to do             │
                                        │   executes their actions for real    │
                                        │   records every step as an event     │
                                        ├───────────────┬──────────────────────┤
                                        │ agents/       │ actions/             │
                                        │  PO, Dev, QA  │  writeFile           │
                                        │  (scripted)   │  runCommand          │
                                        │               │  tapParser           │
                                        ├───────────────┴──────────────────────┤
                                        │ storage/  SQLite (node:sqlite)       │
                                        │  stories · runs · events             │
                                        └──────────────────────────────────────┘
                                                      │
                                         data/workspace.db
                                         data/runs/<run-id>/workspace/  (generated code)
```

## People and agents

- **You (human)** request and guide the product. You start runs and review the
  results. You are not an agent.
- **PO (Product Owner)**, **Dev (Developer)** and **QA** are agents. In Milestone 1
  all three are **scripted** (`AgentKind.SCRIPTED`): their decisions come from fixed
  rules and templates in `src/agents/`.
- The **orchestrator** is platform code, not an agent. It runs the steps in order and
  records what happens.

`AgentKind.AI` exists only to make the distinction explicit. No AI-powered agent is
implemented. Every event stores the `agentKind` of the agent it is attributed to, and
the dashboard shows it as a badge.

## Agent contract

```js
class Agent {
  profile            // { id, name, role, summary, responsibilities, kind }
  perform(task, context)                  // -> { messages, actions?, output? }
  review(task, context, actionResults)    // optional, after actions ran
}
```

Agents only **decide**. They return messages and *requests* for actions
(`writeFile`, `runTests`). The orchestrator **executes** those actions, so what
appears in the event log is what actually happened, whoever made the decision.
A future AI-powered agent implements the same contract.

## The Hello World workflow

| # | Step | Agent | Real work done by the platform |
|---|---|---|---|
| 1 | Refine story into acceptance criteria | PO | writes `ACCEPTANCE.md` |
| 2 | Implement the story | Dev | writes `package.json`, `hello.js` |
| 3 | Write and run acceptance tests | QA | writes `hello.test.js`, runs `node --test --test-reporter=tap hello.test.js`, parses the output |
| 4 | Accept or reject against definition of done | PO | updates the story to `done` or `failed` |

Run modes: `standard`, and `faulty`, where Dev writes an implementation that ignores
the name argument, so AC2 fails for real.

## Execution events

Stored in the `events` table with a per-run sequence number, timestamp, step,
agent id and agent kind. They are broadcast over `/api/stream` as they are stored.

| Type | Meaning |
|---|---|
| `run.started` / `run.completed` / `run.error` | run lifecycle |
| `story.updated` | story status change |
| `step.started` / `step.completed` | workflow step lifecycle |
| `agent.message` | what an agent reports |
| `file.written` | a file was written (path, bytes, sha256) |
| `command.started` / `command.output` / `command.exited` | a real child process |
| `test.result` / `test.summary` | parsed test runner results |

Runs still marked `running` when the server starts (cut off by a shutdown) are marked
`interrupted`.

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | team, stories, workflows, recent runs |
| POST | `/api/stories/:id/runs` | start a run, body `{ "mode": "standard" \| "faulty" }` → 202 |
| GET | `/api/runs/:id` | run and all its events |
| GET | `/api/runs/:id/files` | files in the run workspace, read from disk |
| GET | `/api/stream` | Server-Sent Events: `execution` and `change` |

## Compatibility choices (macOS 11, Intel, 8 GB)

- Node 22 LTS is the newest Node line that supports macOS 11.
- `node:sqlite` is built into Node ≥ 22.13: no native modules to compile. Its
  "experimental" warning is suppressed in the npm scripts.
- No Docker or Homebrew, since neither supports Big Sur any more.
- The dashboard uses no build step and avoids browser features newer than Safari 16.
- The server binds to `127.0.0.1`, because it runs generated code.

## Out of scope for Milestone 1

AI-powered agents, TypeScript, CI, user-defined stories and workflows, and
authentication. These are possible later steps.

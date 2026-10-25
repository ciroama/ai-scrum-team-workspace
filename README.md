# ai-scrum-team-workspace
A local-first AI Scrum Team Workspace with real agent orchestration and execution tracking.

## Milestone 1

A dashboard for a Scrum team made of three agents and you:

| Member | Kind | Responsibility |
|---|---|---|
| **You** | Human | Request and guide the product: start runs, review results |
| **PO** (Product Owner) | Scripted agent | Refines stories into acceptance criteria and accepts or rejects the result |
| **Dev** (Developer) | Scripted agent | Implements the story as code in the run workspace |
| **QA** (Quality Assurance) | Scripted agent | Writes tests from the acceptance criteria, runs them, reports the results |

The team delivers a real **Hello World** story: the PO writes acceptance criteria,
Dev writes `hello.js`, QA generates `hello.test.js` and runs it with the Node.js test
runner, and the PO accepts or rejects the story based on the actual exit code and
results. Every step is recorded as an execution event in SQLite and streamed live to
the dashboard.

### Scripted vs AI-powered agents

**All agents in Milestone 1 are scripted.** They follow fixed rules and templates
written in this repository. No AI model is called and no API key is used. The
dashboard labels every agent and every event with its kind (`Scripted`,
`AI-powered`, `Human`, `System`), so scripted behaviour is never presented as AI.

What *is* real: the files written to disk, the `node --test` process that runs,
its output, its exit code and the test results parsed from it.
**Run with injected defect** makes Dev write a broken implementation on purpose.
QA then reports a genuine failing test and the PO rejects the story.

AI-powered agents (a local model, the Claude Code CLI, an API key) are a possible
later, optional step. The agent interface already separates *deciding* (the agent)
from *doing* (the platform), so a model-backed agent can be added without changing
the rest of the platform.

## Requirements

- **Node.js 22 LTS, version 22.13 or newer** (but not 23+). No other dependencies:
  no Docker, no Homebrew, no database server, no paid services.
- Designed for macOS 11 Big Sur (Intel), 8 GB RAM. It was developed and tested on Linux with Node 22; the first run on a Mac is the real check. The server uses little memory and
  binds to `localhost` only.

## Setup on macOS 11 (Big Sur)

1. Check git: `git --version`. If it is missing, run `xcode-select --install`.
2. Install Node.js 22 LTS with the macOS installer (`.pkg`) from
   <https://nodejs.org/en/download> (choose version 22, "macOS Installer").
   Check with `node -v` — it should print `v22.13.0` or later 22.x.

## Run

```bash
git clone https://github.com/ciroama/ai-scrum-team-workspace.git
cd ai-scrum-team-workspace
git checkout claude/bold-einstein-mb3ux1   # until merged into main
npm install    # no packages to download; sets up the npm scripts
npm test       # platform tests, including end-to-end workflow runs
npm start      # then open http://localhost:3000
```

In the dashboard, click **Run workflow** on the Hello World story. Then try
**Run with injected defect** and watch a real test fail.

Options (environment variables):

- `PORT` — HTTP port (default `3000`), e.g. `PORT=4000 npm start`
- `WORKSPACE_DATA_DIR` — where the SQLite database and generated run workspaces are
  stored (default `./data`, ignored by git). Delete the folder to start fresh.

## Verifying it is real

- Compare the dashboard's test numbers with the files on disk:
  `data/runs/<run-id>/workspace/` contains the generated `hello.js` and
  `hello.test.js`. Running `node --test` in that folder gives the same result.
- Restart the server: runs, events and story status are still there (SQLite).
- `npm test` runs the whole workflow in a temporary folder and checks the stored
  events, the generated files and the test results for both the passing and the
  failing path.

See [docs/architecture.md](docs/architecture.md) for how it fits together.

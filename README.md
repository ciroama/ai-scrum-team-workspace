# ai-scrum-team-workspace
A local-first AI Scrum Team Workspace with real agent orchestration and execution tracking.

## What it is

A dashboard where you, the product requester, describe what you want built.
A team of three agents turns the request into a real, tested product, and you
watch every step:

| Member | Kind | Responsibility |
|---|---|---|
| **You** | Human | Submit requirements, give direction, make product decisions |
| **PO** (Product Owner) | Scripted agent | Turns the request into requirements and acceptance criteria, asks for clarification, reviews the verified result |
| **Developer** | Scripted agent | Implements the requirements as real files, fixes defects reported by QA |
| **QA** (Quality Assurance) | Scripted agent | Turns acceptance criteria into tests, runs them, reports results and defects, re-tests corrections |

A lightweight orchestrator (infrastructure, not a team member) assigns work,
checks agent availability, and records every step.

### Scripted or AI-powered agents

Each agent works in one of two modes, shown on every card and message:

- **Scripted** (default): fixed rules and templates written in this
  repository. No AI model, no autonomous reasoning.
- **AI-powered** (PO and Developer only): decisions come from a model on
  **GitHub Models**, the free, rate-limited AI service included with every
  GitHub account. No paid API is used.

**QA is always scripted.** It turns the PO's acceptance criteria into
deterministic tests and runs them for real, so verification stays independent
of the model that wrote the code. The PO's final acceptance is also a rule
(accepted only when QA verified every criterion) and is labelled as such.

What is real in both modes: the requirements document, the product files
written to disk, the `node --test` run and its results, the Git commits, and
every recorded event and handoff. Every AI request is recorded too, with the
model, duration and token counts reported by the service.

#### Turning on the AI (GitHub Models)

1. Create a token at <https://github.com/settings/personal-access-tokens/new>.
   Give it a name and an expiration, and under **Permissions** add **Models**
   with **Read-only** access. No repository access is needed.
2. In the dashboard open **Team**. Paste the token in **AI provider: GitHub
   Models**, click **Save**, then **Test connection**.
3. On the PO and Developer cards set **Brain** to **AI-powered (GitHub
   Models)**.

The token is stored only on your computer, in `data/workspace.db`. It is never
uploaded to GitHub and never sent back to the browser. When the PO or the
Developer is AI-powered, your request text and the generated files are sent
to GitHub Models over the internet.

Limits and behaviour:

- The free tier is rate-limited (GitHub documents roughly 50–150 requests per
  day, depending on the model). A workflow uses about 2–4 requests.
- If the service cannot be used (no internet, invalid token, limit reached,
  an unusable answer), the workflow is **Blocked** with the reason. Fix it
  and click **Resume**; nothing is invented in the meantime.
- In AI mode the team can build any **static web page** (HTML, CSS, browser
  JavaScript). The PO asks for clarification when a request cannot be built
  that way.
- The default model is `openai/gpt-4.1-mini`. You can change it on the Team
  page.

### Supported requests (scripted PO)

The scripted PO matches requests against a catalogue of supported request types. This
milestone supports one: **Hello World web application**. The PO recognises
wording such as "Build a Hello World application" or "Build a simple Hello
World web application". Anything else gets an honest "needs clarification"
reply that lists the supported types. New types (for example a website or a
Breakout game) are added as recipes in `src/recipes/` without changing the
dashboard.

The generated product is a static web page (`index.html`, `app.js`,
`src/greet.js`, `styles.css`, tests, README). You can open it by double-clicking
`index.html`. QA verifies it with Node tests, without a browser.

## Using the dashboard

- **Home** — the Product Workspace conversation: your request, the PO's
  requirements, handoffs between agents, QA's verdict and the PO's review, all
  taken from recorded events. A compact stage tracker shows where the workflow
  is. If a workflow is blocked, a banner with **Resume** and **Cancel** appears
  in the conversation.
- **AI Scrum Team** (right column and Team page) — each agent shows its
  **availability** (Enabled/Disabled, which is configuration) and, separately,
  its **execution status** (Idle, Working, Waiting, Completed, Failed). Use the
  switch to enable or disable an agent.
- **Team Activity** — every recorded event with evidence: files, commands,
  output, test results, defects, commits, configuration changes.
- **Repository** — the result: outcome, acceptance criteria, test results,
  open issues, generated files (read from disk) and Git commits.
- **Projects** — all workflows, newest first.
- **Live Preview** (right column) — the generated product running locally,
  shown in the dashboard. See below.
- **Analytics** — statistics calculated from recorded data, with a project
  filter and an optional date range. See below.

### Live Preview

Click **Start preview** to run the product of the workflow shown on the
dashboard. The product is served by a separate local preview server on its
own port (127.0.0.1, a free port chosen automatically, or `PREVIEW_PORT`).
The status is **Not Started**, **Starting**, **Running** or **Error**.
"Running" is shown only after the product's page has actually been loaded
from the preview server. Use the refresh button to reload and re-check it, or
the open button to view it in a new browser tab. There is only one preview
server: starting another workflow's preview switches it, and the old address
stops serving. If the product is missing, or the server cannot start, the panel
shows the reason.

### Analytics

All numbers are calculated from the workflows, tasks and events stored in
`data/workspace.db`. Nothing is sample data. Each metric is labelled
**Recorded** (read directly from records or events) or **Calculated**
(derived from them), and the page explains how each one is computed. When
there is not enough data, it shows "Not enough data yet" instead of a number.

- **Project filter:** *All Projects*, or one project. A project is the product
  type the PO assigned; workflows the PO never analysed are grouped as
  *Unassigned*. Each workflow belongs to exactly one project, so nothing is
  counted twice.
- **Date filter:** by the date each workflow was submitted.
- **Not available:** waiting time between handoffs (the next agent starts
  immediately; only time blocked by a disabled agent is measured), agent idle
  time, and Milestone 1 history.

### Enabling and disabling agents

- A disabled agent receives no new assignments. The orchestrator checks
  availability before every assignment.
- If a disabled agent is needed, the workflow stops as **Blocked** at that
  stage and explains why. Re-enable the agent and click **Resume**. The
  workflow continues from the saved stage; earlier work is not repeated.
- If you disable an agent while it is working, its current task finishes
  safely, then it receives no new work.
- QA verification is never reported as passed unless QA actually ran the
  checks.
- The configuration is saved in the local database and survives restarts.

One workflow runs at a time. A blocked workflow keeps that slot until you
resume or cancel it.

## Requirements

- **Node.js 22 LTS, version 22.13 or newer** (not 23 or later). No packages to
  install, no Docker, no Homebrew, no database server, no paid services.
- **Optional: Git.** On macOS Git comes with Apple's Command Line Tools
  (`xcode-select --install`). Without it, products are still built, tested and
  saved; the dashboard explains that no commit was made.
- Designed for macOS 11 Big Sur (Intel), 8 GB RAM. The server uses little
  memory and listens on `localhost` only.

## Setup on macOS 11 (Big Sur)

1. Install Node.js 22 with the macOS installer (`.pkg`) from
   <https://nodejs.org/dist/latest-v22.x/>. Do not install Node 24 or newer;
   it does not support macOS 11.
2. Check in Terminal: `node -v` should print `v22.13.0` or a later 22.x.
3. Download the project: while signed in to github.com, open
   <https://github.com/ciroama/ai-scrum-team-workspace/archive/refs/heads/claude/bold-einstein-mb3ux1.zip>
   and unzip it (or use `git clone` and `git checkout claude/bold-einstein-mb3ux1`).

## Run

In Terminal, go to the project folder (type `cd `, drag the folder into the
window, press Enter), then:

```bash
npm test       # platform tests, including real end-to-end workflows
npm start      # then open http://localhost:3000
```

Keep the Terminal window open while you use the dashboard. Press `Ctrl + C`
to stop it.

Options (environment variables):

- `PORT` — HTTP port (default `3000`), e.g. `PORT=4000 npm start`
- `PREVIEW_PORT` — port of the Live Preview server (default: a free port)
- `WORKSPACE_DATA_DIR` — where the database and generated products are stored
  (default `./data`, ignored by Git). Delete it to start fresh.

If you used Milestone 1, its database is kept as `data/workspace.v1.db`.

## Where things are stored

- `data/workspace.db` — SQLite: workflows, tasks, events, agent configuration
- `data/workflows/<workflow-id>/product/` — the generated product, with its own
  local Git repository. It is separate from this dashboard's repository: every
  Git command uses explicit `--git-dir`/`--work-tree` paths, and nothing is
  pushed anywhere.

See [docs/architecture.md](docs/architecture.md) for the design.

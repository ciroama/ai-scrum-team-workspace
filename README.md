# AI Scrum Team Workspace

A local-first dashboard for **studying how a small Scrum team of AI agents
works**. You describe a product, and a Product Owner, a Developer and a QA
agent turn it into real files that are tested for real. Every step is
recorded: requirements, handoffs, files, commands, test results, defects,
corrections, Git commits and every AI request.

> **Status: experimental.** This is a personal research project, not a
> product. The team builds small static web pages; the point is to observe
> the team at work, not the quality of what it builds.

## Contents

- [Why this project exists](#why-this-project-exists)
- [Ground rules](#ground-rules)
- [The team](#the-team)
- [How a request flows](#how-a-request-flows)
- [What the dashboard shows](#what-the-dashboard-shows)
- [Getting started](#getting-started)
- [Turning on the AI (Claude Code)](#turning-on-the-ai-claude-code)
- [Running on an older Mac (virtual machine)](#running-on-an-older-mac-virtual-machine)
- [Configuration](#configuration)
- [Data, privacy and security](#data-privacy-and-security)
- [How it is built](#how-it-is-built)
- [Tests](#tests)
- [Limitations](#limitations)
- [History](#history)
- [Disclaimer](#disclaimer)
- [License](#license)

## Why this project exists

I want to understand how a team of AI agents behaves when it works the way a
Scrum team does:

- how a Product Owner turns a vague request into requirements;
- how a Developer implements them;
- how QA verifies the result and sends defects back;
- how the team handles a change to something it already built.

To learn anything from that, **everything the dashboard shows has to be
real**. A nice-looking simulation would be useless, so the project follows a
few strict rules (below). The products are deliberately small, such as a
Hello World page or a coloured landing page, so that a whole cycle takes
minutes and is easy to inspect.

## Ground rules

- **Only real events.** Every message, status and number in the dashboard
  comes from something that actually happened and was recorded. Nothing is
  invented: no fake conversations, no assumed test results, no sample data.
- **Honest labels.** Every agent and every message says whether it came
  from a **scripted** agent (fixed rules written in this repository) or an
  **AI-powered** one (a Claude model). Scripted behaviour is never presented
  as AI.
- **Independent verification.** QA is always scripted. It turns the
  acceptance criteria into deterministic tests and runs them with
  `node --test`, so the model that wrote the code never grades its own work.
  A result counts as verified only if QA actually ran the checks.
- **Exactly three agents: PO, Developer and QA.** The orchestrator that
  assigns work is infrastructure, not a team member. You, the human, are not
  an agent: you make the product decisions.
- **Local-first, no paid API.** Everything runs on your own computer. The AI
  agents use Claude Code with your existing Claude subscription. No API key
  and no pay-per-use billing.
- **Blocked, not faked.** When something is missing (an agent is disabled,
  the AI is unavailable, the usage limit is reached), the workflow stops as
  **Blocked** with the reason. You fix the cause and click **Resume**.

## The team

| Member | Kind | Responsibility |
|---|---|---|
| **You** | Human | Describe what to build, ask for changes, enable or disable agents, resume or cancel blocked work |
| **PO** (Product Owner) | Scripted or AI-powered | Turns a request into requirements and machine-checkable acceptance criteria; asks for clarification; applies change requests to the requirements; reviews the verified result |
| **Developer** | Scripted or AI-powered | Writes the product files; changes them for change requests; fixes defects reported by QA |
| **QA** (Quality Assurance) | Always scripted | Generates one test per acceptance criterion, runs all tests, reports results and defects, and re-tests every correction |
| Orchestrator | Infrastructure | Assigns each stage to the responsible agent if it is enabled, executes the work, records every step |

### Scripted or AI-powered

You choose each agent's **Brain** on the Team page:

- **Scripted** (the default): rules and templates in `src/agents/` and
  `src/recipes/`, with no AI model. The scripted PO recognises one kind of
  request, a **Hello World web application**, and honestly answers "needs
  clarification" for anything else.
- **AI-powered** (PO and Developer): the agent's decisions come from a
  Claude model through Claude Code. The team can then build any **static
  web page** (HTML, CSS and browser JavaScript, with no server and no
  external resources).

The PO's **final acceptance is always a rule**, even when the PO is
AI-powered: the product is accepted only if QA verified every acceptance
criterion. The dashboard labels that decision as rule-based.

## How a request flows

```mermaid
flowchart LR
    U([You]) -->|request| A[PO: requirement analysis]
    A -->|needs clarification| U
    A -->|requirements + acceptance criteria| I[Developer: implementation]
    I -->|files + commit| V[QA: verification]
    V -->|defects| C[Developer: correction]
    C --> V
    V -->|all criteria pass| R[PO: final review]
    R --> D([Completed and verified])
```

1. **Requirement analysis (PO).** The PO writes `REQUIREMENTS.md` with
   requirements and acceptance criteria. Each criterion has a check that QA
   can test automatically, such as "the page shows the text *hello world*"
   or "the background colour is green". If the request is unclear or cannot
   be built, the PO asks you instead of guessing.
2. **Implementation (Developer).** The product files are written to disk and
   committed to the product's own Git repository.
3. **Verification (QA).** QA generates `test/acceptance.test.mjs` from the
   criteria, runs every test, and reports a verdict with evidence.
4. **Correction (Developer).** If tests fail, QA sends the defects back. The
   Developer gets up to three attempts in total; then the workflow ends as
   failed and the open defects stay visible.
5. **Final review (PO).** The PO accepts the product only if QA verified
   every criterion.

One workflow runs at a time. A blocked workflow keeps that slot until you
resume or cancel it.

### New products and change requests

The dashboard opens with a clean workspace, ready for a new request (work
that is still running or blocked is shown instead). Below the request box,
**For** chooses what a request is for, and always matches what is on
screen:

- **A new product**: the team starts from scratch. Choosing it, or clicking
  **New request**, clears the workspace.
- **Change: *product name***: a **change request** to a product that
  already exists. The PO starts from the product's current requirements and
  writes the next version, listing what it added, changed or removed. The
  Developer changes the existing files. QA re-runs the checks for **every**
  criterion, old and new, so a change that breaks something is caught. All
  iterations of a product share one folder and one Git repository.
  Choosing a product in **For**, or opening one of its requests from
  **Projects**, shows its latest conversation and makes the next request a
  change to it.

Change requests need the PO and the Developer in AI-powered mode. The
scripted PO only recognises new Hello World requests, and says so.

## What the dashboard shows

| Page | What you find there |
|---|---|
| **Home** | The conversation between you and the team, built from recorded events; a stage tracker; the request box. Blocked workflows show **Resume** and **Cancel**. |
| **Projects** | Every product with its requests: the first one and each change request. Open a request, see the requirements, request a change, or delete the product. |
| **Requirements** | Every version of a product's requirements and acceptance criteria, with the changes each change request made. |
| **Team** | The three agents, with **Enabled/Disabled** (availability) and **Brain** (scripted or AI-powered); the AI provider settings with a real connection test. |
| **Team Activity** | Every recorded event with its evidence: files with checksums, commands with output and exit codes, test results, defects, commits, AI requests, and configuration changes. |
| **Repository** | The result: outcome, acceptance criteria with their status, test results, open issues, files read from disk, and Git commits. |
| **Analytics** | Statistics calculated from the recorded data, with a project filter and a date range. |
| **Live Preview** (right column) | The generated page, served by a separate local preview server and shown in the dashboard. |

Details worth knowing:

- **Agent availability.** A disabled agent gets no new work. If it is
  needed, the workflow is blocked at that stage. Re-enable it and click
  **Resume**; earlier stages are not repeated. An agent disabled mid-task
  finishes that task first.
- **AI requests.** Every request to the model is recorded with model,
  purpose, duration, token counts and outcome. An answer that does not match
  the agent's contract is retried once, then the workflow blocks with the
  reason.
- **Live Preview** reports **Running** only after the page has actually been
  loaded from the preview server.
- **Analytics** labels each number **Recorded** (read directly from the
  records) or **Calculated** (derived from them), explains how it is
  computed, and shows "Not enough data yet" rather than a guess.
- **Deleting** a product (on Projects or Repository) is permanent and needs
  your confirmation. It removes the product's requests, conversations,
  activity, statistics, files and Git history. **Delete all products** resets
  the workspace. A product whose request is running cannot be deleted.

## Getting started

### Requirements

- **Node.js 22 LTS, version 22.13 or newer**, but not 23 or later. Nothing
  else to install: no npm packages, no database server, no Docker.
- **Git** (recommended). Without it, products are still built, tested and
  saved, and the dashboard says that no commit was made.
- **Claude Code**, only for AI-powered agents (see below).

Developed and tested on macOS and Linux (Windows is untested). The server
uses little memory and listens on `127.0.0.1` only.

### Install and run

```bash
git clone https://github.com/ciroama/ai-scrum-team-workspace.git
cd ai-scrum-team-workspace
npm test     # the full test suite, including real end-to-end workflows
npm start    # then open http://localhost:3000
```

Keep the terminal open while you use the dashboard. Press `Ctrl + C` to
stop it.

To try it without any AI: leave all agents scripted and ask for
*"Build a simple Hello World web application"*.

On **macOS 11 (Big Sur)**, install Node.js 22 with the `.pkg` installer
from <https://nodejs.org/dist/latest-v22.x/>. Newer Node versions do not
support macOS 11. Claude Code does not run on macOS 11 either; see
[Running on an older Mac](#running-on-an-older-mac-virtual-machine).

## Turning on the AI (Claude Code)

The AI-powered agents use [Claude Code](https://code.claude.com/docs/en/overview),
logged in with **your own Claude subscription**, for example Claude Pro.

1. Install Claude Code on the computer that runs the workspace:
   `curl -fsSL https://claude.ai/install.sh | bash`. It needs macOS 13 or
   newer, Linux, or Windows.
2. Run `claude` once in a terminal and log in with your Claude account.
   Choose the subscription login, not an Anthropic Console (API) account.
3. In the dashboard open **Team** → **AI provider: Claude Code** → **Test
   connection**. It sends one small real request and shows the result.
4. On the PO and Developer cards, set **Brain** to **AI-powered (Claude
   Code)**.

How the integration behaves:

- **Text only.** Each AI request runs `claude -p` once, in an empty
  temporary folder, with **all tools disabled**. The model can only answer.
  The workspace checks the answer against the agent's contract and then
  writes the files itself. Files must stay inside the product folder, use
  allowed file types, keep out of QA's `test/` folder, and load nothing from
  the internet.
- **Subscription, not paid API.** `ANTHROPIC_API_KEY` and
  `ANTHROPIC_AUTH_TOKEN` are removed from Claude Code's environment, so a key
  set on your computer can never turn this into pay-per-use billing.
- **Usage limits.** Requests count against your subscription's usage limit.
  A workflow uses about 2–4 requests, and more when QA finds defects. The
  default model is `sonnet`, which uses less of the limit than `opus`; you
  can change it on the Team page. When the limit is reached, the workflow
  blocks with the reason; resume it later.
- **Failures are explicit.** If Claude Code is not installed, not logged in,
  over its limit, or gives no answer within 5 minutes, the workflow blocks
  and says why.

## Running on an older Mac (virtual machine)

Claude Code needs macOS 13 or newer. On an older Mac (this project was built
on an Intel MacBook Air with macOS 11 and 8 GB of RAM), run the workspace
in a small Linux virtual machine and use it from the Mac's browser.

1. Install [UTM](https://mac.getutm.app/). For macOS 11, use
   [UTM 4.7.5](https://github.com/utmapp/UTM/releases/tag/v4.7.5), the last
   version that supports it.
2. Create a VM with **Virtualize → Linux** and an **Ubuntu Server** (amd64)
   ISO: 4 GB of memory, 2 CPU cores, about 25 GB of disk. During
   installation, choose **Install OpenSSH server**. Before the first boot,
   remove the ISO from the VM's drives.
3. In the VM, install Node.js and Git, then Claude Code, and log in:

   ```bash
   sudo apt update && sudo apt install -y nodejs npm git   # check: node -v shows v22.13 or newer
   curl -fsSL https://claude.ai/install.sh | bash
   claude                                                  # log in once, then /exit
   ```

4. In the VM, clone this repository and run `npm test` and `npm start`.
5. On the Mac, open a terminal and connect with a tunnel for the dashboard
   and the Live Preview ports. Replace the user name and address with your
   VM's; `hostname -I` in the VM shows the address.

   ```bash
   ssh -L 3000:127.0.0.1:3000 -L 3001:127.0.0.1:3001 <user>@<vm-address>
   ```

6. Open <http://localhost:3000> on the Mac. Keep the SSH window open.

Inside the VM, the workspace still listens only on `127.0.0.1`; the tunnel is
the only way in.

## Configuration

Environment variables, for example `PORT=4000 npm start`:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Dashboard port |
| `PREVIEW_PORT` | `3001` | Live Preview port (`0` picks a free one) |
| `WORKSPACE_DATA_DIR` | `./data` | Where the database and the generated products are stored |
| `CLAUDE_BINARY` | `claude` | The Claude Code command, if it is not on the `PATH` as `claude` |

Everything else (agent availability, agent modes, the model) is set in the
dashboard and saved in the local database.

## Data, privacy and security

- **Everything stays on your computer** in `data/`, which Git ignores:
  - `data/workspace.db` (SQLite): products, workflows, tasks, events,
    settings;
  - `data/workflows/<product-id>/product/`: the generated files, with their
    own Git repository.
- **Product repositories are isolated.** Every Git command runs with
  explicit `--git-dir`/`--work-tree` paths, so it can never touch this
  dashboard's repository. Nothing is ever pushed anywhere.
- **No credentials are stored.** The Claude login belongs to Claude Code.
- **What leaves your computer:** only when the PO or the Developer is
  AI-powered. Then your request text, the requirements and the product files
  are sent to Anthropic through Claude Code.
- **Local only.** The dashboard and the preview server listen on
  `127.0.0.1`. There is no login, so do not expose them to a network.
- **Generated code runs locally.** QA runs the generated tests with Node.js
  on your computer, and the preview serves the generated page. The AI
  produces only static web pages, checked against the contract before they
  are written.
- **Deletion is real.** Deleting a product removes its records and its
  folder.

## How it is built

Plain Node.js (ES modules) and plain browser JavaScript. There is **no build
step and no dependencies**. It uses the built-in `node:sqlite` for storage,
`node --test` for tests, and Server-Sent Events for live updates.

```
src/
  main.js              entry point (checks the Node.js version)
  server/app.js        HTTP API, static files, live updates (SSE)
  core/                orchestrator (workflow state machine), stages, agent activity
  agents/              scripted PO, Developer, QA; team roster; ai/ AI-powered PO and Developer
  ai/                  Claude Code client, AI settings, contracts that validate model answers
  recipes/             request types the scripted agents know (Hello World)
  storage/             SQLite schema and repository
  actions/             file writing, command running, TAP parsing, isolated Git
  preview/             Live Preview server
  analytics/           statistics computed from recorded data
public/                dashboard (HTML, CSS, JavaScript modules)
test/                  node:test suites
docs/architecture.md   design details: state machine, events, contracts, API
```

The full design, including every event type, the agent contracts, the HTTP
API and the database schema, is in
[docs/architecture.md](docs/architecture.md).

## Tests

```bash
npm test
```

The suite runs real end-to-end workflows: real files, real `node --test`
runs and real Git commits in temporary folders. It also covers blocking and
resuming, the correction loop, change requests, deletion, Live Preview,
Analytics and the database migrations.

The AI paths run against a stand-in `claude` command that returns prepared
answers, so the tests need no account and use no quota. The real Claude Code
integration was checked by hand.

## Limitations

- The **scripted** agents know one request type: a Hello World web
  application.
- The **AI-powered** team builds static web pages only.
- QA's checks are deterministic but simple: visible text, page title, files,
  CSS property values (colours compared after normalisation) and centred
  layout. QA does not use a browser, so it cannot judge visual quality.
- QA itself is not AI-powered, by design.
- One workflow at a time. An interrupted stage reruns from its start.
- The AI's output depends on the model. Answers that break the contract
  block the workflow instead of being used.
- No user accounts, and not meant for a shared network.

## History

The project was built in milestones, all recorded in the Git history:

1. A dashboard with scripted agents and a real Hello World workflow.
2. A full workflow engine: enable and disable agents, block and resume, the
   correction loop, and a team workspace layout.
3. Live Preview and Analytics.
4. AI-powered PO and Developer. The first version used GitHub Models, which
   GitHub retired on 30 July 2026. It was replaced by Claude Code, using a
   Claude subscription.
5. Products with change requests, versioned requirements, and permanent
   deletion.

## Disclaimer

An independent personal project, not affiliated with or endorsed by
Anthropic or GitHub. Using Claude Code is subject to Anthropic's terms and
your subscription's usage limits.

## License

[MIT](LICENSE) © 2026 Ciro Amati. You may use, copy, modify and share the
code, as long as you keep the copyright and license notice. It comes with
no warranty.

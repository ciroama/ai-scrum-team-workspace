import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { resolveInside, writeFile } from '../actions/writeFile.js';
import { runCommand } from '../actions/runCommand.js';
import { parseTap } from '../actions/tapParser.js';
import { commitAll, detectGit } from '../actions/git.js';
import { RECIPES } from '../recipes/index.js';
import { MAX_IMPLEMENTATION_ATTEMPTS, STAGES } from './stages.js';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export const REQUEST_LIMITS = { min: 3, max: 2000 };
const OUTPUT_LIMIT = 20_000;
const MAX_FILE_PREVIEW = 200_000;

const now = () => new Date().toISOString();
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const truncate = (text) =>
  text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… (${text.length - OUTPUT_LIMIT} more characters)` : text;
const formatMs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

const STAGE_CATEGORY = {
  analysis: 'analysis',
  implementation: 'implementation',
  correction: 'correction',
  verification: 'test',
  review: 'review',
};

/**
 * Coordinates workflows: assigns each stage to the responsible agent (only
 * if that agent is enabled), executes the work the agent asks for, records
 * every step as an event and moves the workflow to its next state.
 *
 * Infrastructure only: it makes no product decisions itself.
 */
export class Orchestrator {
  /**
   * @param {object} deps
   * @param {import('../storage/repository.js').Repository} deps.repository
   * @param {Map<string, import('../agents/agent.js').Agent>} deps.team
   * @param {string} deps.dataDir
   * @param {object[]} [deps.recipes]
   * @param {string} [deps.gitBinary]
   * @param {number} [deps.commandTimeoutMs]
   */
  constructor({ repository, team, dataDir, recipes = RECIPES, gitBinary = 'git', commandTimeoutMs = 60_000 }) {
    this.repository = repository;
    this.team = team;
    this.dataDir = dataDir;
    this.recipes = recipes;
    this.gitBinary = gitBinary;
    this.commandTimeoutMs = commandTimeoutMs;
    /** @type {{ workflowId: string, promise: Promise<object> } | null} */
    this.current = null;
    this.gitStatus = null;
    this.gitNoticeSent = new Set();
  }

  /** Prepares agent configuration and records workflows cut off by a previous shutdown. */
  init() {
    this.repository.ensureAgents([...this.team.keys()]);
    for (const workflow of this.repository.markInterrupted()) {
      this.#event(workflow.id, {
        type: 'workflow.interrupted',
        category: 'workflow',
        status: 'warning',
        summary:
          `The application stopped while "${STAGES[workflow.stage].title}" was in progress. ` +
          'Click Resume to run that stage again, or cancel the workflow.',
      });
    }
  }

  /** Git availability, detected once per process. */
  git() {
    this.gitStatus ??= detectGit({ binary: this.gitBinary });
    return this.gitStatus;
  }

  productDir(workflowId) {
    return join(this.dataDir, 'workflows', workflowId, 'product');
  }

  label(actor) {
    if (actor === 'user') return 'You';
    return this.team.get(actor)?.label ?? 'System';
  }

  // ---- commands from the user ------------------------------------------------

  /**
   * Validates and records a requirement, then runs its workflow in the background.
   * @returns {{ workflow: object, done: Promise<object> }}
   */
  submit(requestText) {
    if (typeof requestText !== 'string' || requestText.trim() === '') {
      throw new ValidationError('Please describe what you would like to build.');
    }
    const text = requestText.trim();
    if (text.length < REQUEST_LIMITS.min) {
      throw new ValidationError('The request is too short. Please describe what you would like to build in a few words.');
    }
    if (text.length > REQUEST_LIMITS.max) {
      throw new ValidationError(`The request is too long (${text.length} characters). Please keep it under ${REQUEST_LIMITS.max} characters.`);
    }

    const active = this.repository.findActiveWorkflow();
    if (active) {
      throw new ConflictError(
        active.status === 'blocked'
          ? `"${active.title}" is blocked at ${STAGES[active.stage].title}. Resume or cancel it before starting a new request — this milestone runs one workflow at a time.`
          : `"${active.title}" is still running. This milestone runs one workflow at a time; please wait for it to finish.`,
      );
    }

    const workflow = this.repository.createWorkflow({ requestText: text, stage: 'analysis' });
    const config = this.repository.getAgentConfig();
    const team = [...this.team.values()].map((a) => ({ id: a.id, label: a.label, kind: a.kind, enabled: config[a.id]?.enabled ?? false }));

    this.#event(workflow.id, {
      type: 'request.submitted',
      category: 'request',
      actor: 'user',
      actorKind: 'human',
      summary: `Requirement submitted: "${text}"`,
      detail: { requestText: text },
    });
    this.#event(workflow.id, {
      type: 'workflow.created',
      category: 'workflow',
      summary: `Workflow created. Team availability: ${team.map((a) => `${a.label} ${a.enabled ? 'enabled' : 'disabled'}`).join(', ')}.`,
      detail: { team, productDir: this.productDir(workflow.id) },
    });

    return { workflow: this.repository.getWorkflow(workflow.id), done: this.#start(workflow.id) };
  }

  /** Continues a blocked or interrupted workflow from its saved stage. */
  resume(workflowId) {
    const workflow = this.repository.getWorkflow(workflowId);
    if (!workflow) throw new NotFoundError('Workflow not found');
    if (!['blocked', 'interrupted'].includes(workflow.status)) {
      throw new ConflictError(`Only blocked or interrupted workflows can be resumed; this one is ${workflow.status.replace('_', ' ')}.`);
    }
    const active = this.repository.findActiveWorkflow();
    if ((active && active.id !== workflowId) || (this.current && this.current.workflowId !== workflowId)) {
      throw new ConflictError('Another workflow is in progress. This milestone runs one workflow at a time.');
    }
    const stage = STAGES[workflow.stage];
    const agent = this.team.get(stage.agent);
    if (!this.repository.isAgentEnabled(agent.id)) {
      throw new ConflictError(`${agent.label} is still disabled. Enable ${agent.label} before resuming ${stage.title}.`);
    }

    this.repository.updateWorkflow(workflowId, { status: 'running', blockedReason: null });
    this.#event(workflowId, {
      type: 'workflow.resumed',
      category: 'workflow',
      actor: 'user',
      actorKind: 'human',
      summary:
        `Workflow resumed at ${stage.title}` +
        (workflow.status === 'interrupted' ? ' (the interrupted stage runs again from the start).' : '.'),
    });
    return { workflow: this.repository.getWorkflow(workflowId), done: this.#start(workflowId) };
  }

  /** Abandons a blocked or interrupted workflow, freeing the workflow slot. */
  cancel(workflowId) {
    const workflow = this.repository.getWorkflow(workflowId);
    if (!workflow) throw new NotFoundError('Workflow not found');
    if (!['blocked', 'interrupted'].includes(workflow.status)) {
      throw new ConflictError(`Only blocked or interrupted workflows can be cancelled; this one is ${workflow.status.replace('_', ' ')}.`);
    }
    this.repository.updateWorkflow(workflowId, { status: 'cancelled', finishedAt: now() });
    this.#event(workflowId, {
      type: 'workflow.cancelled',
      category: 'workflow',
      actor: 'user',
      actorKind: 'human',
      status: 'warning',
      summary: `Workflow cancelled at ${STAGES[workflow.stage].title}. It was not completed${workflow.verified ? '' : ' or verified'}.`,
    });
    return this.repository.getWorkflow(workflowId);
  }

  /**
   * Changes an agent's availability. Takes effect for the next assignment:
   * a task the agent is already running is allowed to finish.
   * @returns {{ changed: boolean }}
   */
  setAgentEnabled(agentId, enabled) {
    const agent = this.team.get(agentId);
    if (!agent) throw new NotFoundError(`Unknown agent "${agentId}"`);
    if (typeof enabled !== 'boolean') throw new ValidationError('"enabled" must be true or false');
    if (this.repository.isAgentEnabled(agentId) === enabled) return { changed: false };

    this.repository.setAgentEnabled(agentId, enabled);
    const running = this.repository.listRunningTasks().find((t) => t.agentId === agentId);
    const active = this.repository.findActiveWorkflow();

    let summary;
    if (!enabled) {
      summary = running
        ? `${agent.label} disabled. Its current task ("${running.title}") will finish safely; after that ${agent.label} receives no new assignments.`
        : `${agent.label} disabled. ${agent.label} will not receive new assignments.`;
    } else {
      summary = `${agent.label} enabled and available for new assignments.`;
      if (active?.status === 'blocked' && STAGES[active.stage].agent === agentId) {
        summary += ' The blocked workflow can now be resumed.';
      }
    }
    this.#event(active?.id ?? null, {
      type: enabled ? 'agent.enabled' : 'agent.disabled',
      category: 'config',
      actor: 'user',
      actorKind: 'human',
      status: enabled ? 'success' : 'warning',
      summary,
      detail: { agentId, enabled, finishingTask: running?.title ?? null },
    });
    return { changed: true };
  }

  // ---- read models ---------------------------------------------------------

  /** Files in a workflow's product folder (excluding .git), read from disk. */
  async listProductFiles(workflowId) {
    const root = this.productDir(workflowId);
    const files = [];
    const walk = async (dir) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === '.git') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          const { size } = await stat(full);
          const content = size <= MAX_FILE_PREVIEW ? await readFile(full, 'utf8') : null;
          files.push({ path: relative(root, full).split('\\').join('/'), bytes: size, content });
        }
      }
    };
    await walk(root);
    return { root, files };
  }

  // ---- workflow engine -----------------------------------------------------

  #start(workflowId) {
    const promise = this.#drive(workflowId).finally(() => {
      if (this.current?.workflowId === workflowId) this.current = null;
    });
    this.current = { workflowId, promise };
    return promise;
  }

  async #drive(workflowId) {
    try {
      for (;;) {
        const workflow = this.repository.getWorkflow(workflowId);
        if (workflow.status !== 'running') return workflow;
        const stage = STAGES[workflow.stage];
        const agent = this.team.get(stage.agent);
        // Availability is checked before every assignment.
        if (!this.repository.isAgentEnabled(agent.id)) this.#block(workflow, stage, agent);
        else await this.#runStage(workflow, stage, agent);
      }
    } catch (error) {
      this.#event(workflowId, {
        type: 'workflow.failed',
        category: 'error',
        status: 'failure',
        summary: `The workflow stopped because of an execution error: ${error.message}`,
        error: error.stack ?? error.message,
      });
      return this.repository.updateWorkflow(workflowId, { status: 'failed', error: error.message, finishedAt: now() });
    }
  }

  #block(workflow, stage, agent) {
    const consequence = {
      analysis: 'No requirement analysis has been performed.',
      implementation: 'No implementation work has been done.',
      correction: 'The reported defects have not been fixed.',
      verification: 'The implementation has not been verified.',
      review: 'The outcome has not been reviewed or accepted.',
    }[stage.id];
    const reason = `${stage.title} is blocked: ${agent.label} is disabled.`;
    this.repository.updateWorkflow(workflow.id, { status: 'blocked', blockedReason: reason, verified: false });
    this.#event(workflow.id, {
      type: 'workflow.blocked',
      category: 'workflow',
      status: 'warning',
      summary: `${reason} ${consequence} Enable ${agent.label} and click Resume to continue from this stage.`,
      detail: { stage: stage.id, agentId: agent.id },
    });
  }

  async #runStage(workflow, stage, agent) {
    const task = this.repository.startTask({
      workflowId: workflow.id,
      agentId: agent.id,
      stage: stage.id,
      title: stage.taskTitle,
      input: { stage: stage.id, attempt: workflow.state.attempt ?? 0 },
    });
    const category = STAGE_CATEGORY[stage.id];
    const ctx = {
      workflow,
      stage,
      agent,
      task,
      dir: this.productDir(workflow.id),
      say: (fields) => this.#event(workflow.id, { actor: agent.id, actorKind: agent.kind, taskId: task.id, category, ...fields }),
    };
    ctx.say({ type: 'task.started', summary: `${agent.label} started: ${stage.taskTitle.toLowerCase()}.` });

    try {
      const handler = {
        analysis: () => this.#analysis(ctx),
        implementation: () => this.#implementation(ctx),
        correction: () => this.#implementation(ctx),
        verification: () => this.#verification(ctx),
        review: () => this.#review(ctx),
      }[stage.id];
      const { output, update } = await handler();
      this.repository.finishTask(task.id, { status: 'completed', output });
      this.repository.updateWorkflow(workflow.id, update);
    } catch (error) {
      this.repository.finishTask(task.id, { status: 'failed', error: error.message });
      ctx.say({
        type: 'task.failed',
        category: 'error',
        status: 'failure',
        summary: `${agent.label} could not complete "${stage.taskTitle}": ${error.message}`,
        error: error.message,
      });
      throw error;
    }
  }

  // ---- stages --------------------------------------------------------------

  async #analysis(ctx) {
    const { workflow, agent, say } = ctx;
    const result = await agent.analyse({ requestText: workflow.requestText, recipes: this.recipes });

    if (result.status === 'needs_clarification') {
      say({
        type: 'po.clarification',
        from: agent.id,
        to: 'user',
        status: 'warning',
        summary: result.message,
        detail: { reason: result.reason, supported: result.supported },
      });
      this.#event(workflow.id, {
        type: 'workflow.needs_clarification',
        category: 'workflow',
        status: 'warning',
        summary: 'The workflow stopped before implementation because the PO needs a clearer or supported request. Submit a new request to continue.',
      });
      return {
        output: { summary: result.summary, status: result.status },
        update: {
          status: 'needs_clarification',
          title: 'Request needs clarification',
          finishedAt: now(),
          state: { ...workflow.state, clarification: { reason: result.reason, message: result.message, supported: result.supported } },
        },
      };
    }

    const { spec } = result;
    await this.#writeFiles(ctx, [result.document]);
    say({
      type: 'po.requirements',
      status: 'success',
      summary: result.summary,
      detail: {
        requirements: spec.requirements,
        acceptanceCriteria: spec.acceptanceCriteria.map(({ id, description }) => ({ id, description })),
      },
    });
    say({
      type: 'handoff',
      category: 'handoff',
      from: agent.id,
      to: 'dev',
      summary: result.handoffMessage,
      detail: { references: [result.document.path, ...spec.acceptanceCriteria.map((c) => c.id)] },
    });
    return {
      output: { summary: result.summary, recipeId: spec.recipeId },
      update: { recipeId: spec.recipeId, title: spec.title, stage: 'implementation', state: { ...workflow.state, spec, attempt: 0 } },
    };
  }

  async #implementation(ctx) {
    const { workflow, stage, agent, say } = ctx;
    const state = workflow.state;
    const attempt = (state.attempt ?? 0) + 1;
    const correcting = stage.id === 'correction';
    const defects = correcting ? (state.verification?.defects ?? []) : [];

    const result = await agent.implement({ spec: state.spec, attempt, defects });
    const written = await this.#writeFiles(ctx, result.files);
    say({ type: correcting ? 'dev.correction' : 'dev.implementation', status: 'success', summary: result.summary, detail: { attempt, files: written } });

    const commit = await this.#commit(ctx, `${correcting ? 'Correction' : 'Implementation'} (attempt ${attempt}): ${state.spec.title}`);
    say({
      type: 'handoff',
      category: 'handoff',
      from: agent.id,
      to: 'qa',
      summary: result.handoffMessage,
      detail: { references: written.map((f) => f.path), commit },
    });

    const files = written.map((f) => f.path);
    return {
      output: { summary: result.summary, files, commit },
      update: { stage: 'verification', verified: false, state: { ...state, attempt, implementation: { files, commit, attempt } } },
    };
  }

  async #verification(ctx) {
    const { workflow, agent, dir, say } = ctx;
    const state = workflow.state;
    const plan = await agent.planVerification({ spec: state.spec, implementation: state.implementation });
    say({
      type: 'qa.plan',
      summary: plan.summary,
      detail: { commands: plan.commands.map((c) => ({ label: c.label, command: `node ${c.args.join(' ')}` })) },
    });
    await this.#writeFiles(ctx, [plan.testFile]);

    const missingFiles = plan.requiredFiles.filter((path) => !existsSync(resolveInside(dir, path)));
    say({
      type: 'qa.files',
      status: missingFiles.length ? 'failure' : 'success',
      summary: missingFiles.length
        ? `Missing expected files: ${missingFiles.join(', ')}.`
        : `All ${plan.requiredFiles.length} expected files are present.`,
      detail: { required: plan.requiredFiles, missing: missingFiles },
    });

    const commands = [];
    for (const command of plan.commands) commands.push(await this.#runNode(ctx, command));

    const evaluation = await agent.evaluate({ spec: state.spec, results: { missingFiles, commands } });
    const passed = evaluation.verdict === 'pass';
    say({
      type: 'qa.verdict',
      status: passed ? 'success' : 'failure',
      summary: evaluation.summary,
      detail: { verdict: evaluation.verdict, criteria: evaluation.criteria, testSummary: evaluation.testSummary },
    });
    for (const defect of evaluation.defects) {
      say({ type: 'defect.reported', category: 'defect', status: 'failure', summary: defect.title, detail: defect });
    }
    const commit = await this.#commit(ctx, `QA acceptance tests (attempt ${state.attempt})`);

    const verification = {
      executed: true,
      verdict: evaluation.verdict,
      criteria: evaluation.criteria,
      defects: evaluation.defects,
      testSummary: evaluation.testSummary,
      attempt: state.attempt,
      commit,
      at: now(),
    };

    let next;
    if (passed) {
      next = 'review';
      say({ type: 'handoff', category: 'handoff', from: agent.id, to: 'po', status: 'success', summary: evaluation.handoffMessage });
    } else if (state.attempt < MAX_IMPLEMENTATION_ATTEMPTS) {
      next = 'correction';
      say({
        type: 'handoff',
        category: 'handoff',
        from: agent.id,
        to: 'dev',
        status: 'failure',
        summary: evaluation.feedbackMessage,
        detail: { defects: evaluation.defects.map((d) => d.title) },
      });
    } else {
      next = 'review';
      say({
        type: 'handoff',
        category: 'handoff',
        from: agent.id,
        to: 'po',
        status: 'failure',
        summary: `Verification still fails after ${state.attempt} implementation attempts (the limit). ${evaluation.defects.length} defect(s) remain open.`,
        detail: { defects: evaluation.defects.map((d) => d.title) },
      });
    }
    return {
      output: { summary: evaluation.summary, verdict: evaluation.verdict },
      update: { stage: next, verified: false, state: { ...state, verification } },
    };
  }

  async #review({ workflow, agent, say }) {
    const state = workflow.state;
    const review = await agent.review({ spec: state.spec, verification: state.verification ?? null });
    say({ type: 'po.review', status: review.accepted ? 'success' : 'failure', summary: review.summary, detail: { unmet: review.unmet } });

    if (review.accepted) {
      this.#event(workflow.id, {
        type: 'workflow.completed',
        category: 'completion',
        status: 'success',
        summary: `Workflow completed: "${workflow.title}" was built, verified by QA and accepted by the PO.`,
      });
    } else {
      this.#event(workflow.id, {
        type: 'workflow.failed',
        category: 'completion',
        status: 'failure',
        summary: `Workflow failed: ${review.summary}`,
      });
    }
    return {
      output: { summary: review.summary, accepted: review.accepted },
      update: {
        status: review.accepted ? 'completed' : 'failed',
        verified: review.accepted && state.verification?.verdict === 'pass',
        finishedAt: now(),
        state: { ...state, review },
      },
    };
  }

  // ---- execution helpers -----------------------------------------------------

  async #writeFiles({ dir, say }, files) {
    const written = [];
    for (const file of files) {
      const target = resolveInside(dir, file.path);
      const previous = existsSync(target) ? await readFile(target, 'utf8') : null;
      const result = await writeFile(dir, file.path, file.content);
      const change = previous == null ? 'created' : previous === file.content ? 'unchanged' : 'modified';
      const verb = { created: 'Created', modified: 'Modified', unchanged: 'Rewrote (no changes)' }[change];
      say({
        type: 'file.written',
        category: 'file',
        status: 'success',
        summary: `${verb} ${file.path} — ${file.purpose}`,
        detail: { ...result, purpose: file.purpose, change, previousSha256: previous == null ? null : sha256(previous) },
      });
      written.push({ ...result, purpose: file.purpose, change });
    }
    return written;
  }

  async #runNode({ dir, say }, command) {
    const display = `node ${command.args.join(' ')}`;
    say({ type: 'command.started', category: 'command', summary: `${command.label}: ${display}`, detail: { command: display, cwd: dir } });
    const run = await runCommand({ command: process.execPath, args: command.args, cwd: dir, timeoutMs: this.commandTimeoutMs });
    const result = { ...command, exitCode: run.exitCode, timedOut: run.timedOut, durationMs: run.durationMs, stdout: run.stdout, stderr: run.stderr };

    say({
      type: 'command.finished',
      category: 'command',
      status: run.exitCode === 0 ? 'success' : 'failure',
      summary: `${display} finished with exit code ${run.exitCode}${run.timedOut ? ' (timed out)' : ''} in ${formatMs(run.durationMs)}.`,
      detail: {
        command: display,
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
        stdout: truncate(run.stdout),
        stderr: truncate(run.stderr),
      },
    });

    if (command.kind === 'tests') {
      const { tests, summary } = parseTap(run.stdout);
      result.tests = tests.filter((t) => !t.suite);
      result.summary = summary;
      say({
        type: 'test.results',
        category: 'test',
        status: summary.fail === 0 && summary.tests > 0 && run.exitCode === 0 ? 'success' : 'failure',
        summary: `Test results: ${summary.tests ?? 0} tests, ${summary.pass ?? 0} passed, ${summary.fail ?? 0} failed.`,
        detail: { summary, tests: result.tests, exitCode: run.exitCode },
      });
    }
    return result;
  }

  async #commit({ workflow, dir, say }, message) {
    const git = await this.git();
    if (!git.available) {
      if (!this.gitNoticeSent.has(workflow.id)) {
        this.gitNoticeSent.add(workflow.id);
        this.#event(workflow.id, {
          type: 'git.unavailable',
          category: 'git',
          status: 'warning',
          summary: `No Git commit was made: ${git.reason} The generated files are saved in ${dir}.`,
          detail: { reason: git.reason, repository: dir },
        });
      }
      return null;
    }
    const result = await commitAll({ binary: this.gitBinary, dir, message });
    if (!result.ok) {
      this.#event(workflow.id, {
        type: 'git.failed',
        category: 'git',
        status: 'warning',
        summary: `The Git commit failed; the generated files are kept in ${dir}.`,
        error: result.error,
        detail: { repository: dir, message },
      });
      return null;
    }
    if (!result.commit) return null;
    say({
      type: 'git.commit',
      category: 'git',
      status: 'success',
      summary: `Committed ${result.files.length} file(s) to the product repository: ${result.commit.slice(0, 7)} "${message}"`,
      detail: { commit: result.commit, message, files: result.files, repository: dir, initialized: result.initialized },
    });
    return result.commit;
  }

  #event(workflowId, fields) {
    return this.repository.appendEvent({ workflowId, ...fields });
  }
}

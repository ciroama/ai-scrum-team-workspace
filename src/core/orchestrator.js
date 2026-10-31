import { readFile, readdir, rm, stat } from 'node:fs/promises';
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

/** QA's own files: deterministic acceptance tests and AI-written tests. */
const isQaFile = (path) => path.startsWith('test/') || path.startsWith('qa/');

/**
 * The arguments a QA command really runs with. AI-written tests run in-process
 * under Node's permission model: they may read the product folder and nothing
 * else, write nothing, and start no processes or workers.
 */
function sandboxArgs(command, dir) {
  return command.kind === 'ai-tests' ? ['--permission', `--allow-fs-read=${dir}`, ...command.args] : command.args;
}

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

  /**
   * The folder of a workflow's product. All iterations of a product share the
   * folder (and its Git repository) of the product's first workflow.
   */
  productDir(workflowId) {
    const productId = this.repository.getWorkflow(workflowId)?.productId ?? workflowId;
    return join(this.dataDir, 'workflows', productId, 'product');
  }

  /**
   * The latest agreed requirements of a product: the base a change request
   * builds on. The files on disk correspond to this iteration or later work.
   */
  baseOf(productId) {
    const versions = this.repository.listProductWorkflows(productId).filter((w) => w.state?.spec);
    const latest = versions.at(-1);
    return latest ? { workflowId: latest.id, version: latest.state.spec.version ?? versions.length, spec: latest.state.spec } : null;
  }

  label(actor) {
    if (actor === 'user') return 'You';
    return this.team.get(actor)?.label ?? 'System';
  }

  // ---- commands from the user ------------------------------------------------

  /**
   * Validates and records a requirement, then runs its workflow in the background.
   * With a productId the request is a change to that product: the PO starts
   * from its current requirements and the Developer from its current files.
   * @param {string} requestText
   * @param {{ productId?: string | null }} [options]
   * @returns {{ workflow: object, done: Promise<object> }}
   */
  submit(requestText, { productId = null } = {}) {
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

    let base = null;
    if (productId != null) {
      if (typeof productId !== 'string' || !this.repository.listProductWorkflows(productId).length) {
        throw new NotFoundError('This product does not exist (it may have been deleted). Choose another product or start a new one.');
      }
      base = this.baseOf(productId);
      if (!base) {
        throw new ValidationError('This product has no agreed requirements yet, so there is nothing to change. Start a new product instead.');
      }
    }

    const workflow = this.repository.createWorkflow({
      requestText: text,
      stage: 'analysis',
      productId,
      title: base ? base.spec.title : 'New request',
      state: base ? { base } : {},
    });
    const config = this.repository.getAgentConfig();
    const team = [...this.team.values()].map((a) => ({ id: a.id, label: a.label, kind: a.kind, enabled: config[a.id]?.enabled ?? false }));

    this.#event(workflow.id, {
      type: 'request.submitted',
      category: 'request',
      actor: 'user',
      actorKind: 'human',
      summary: base ? `Change request for "${base.spec.title}" (requirements v${base.version}): "${text}"` : `Requirement submitted: "${text}"`,
      detail: { requestText: text, ...(base ? { productId, baseVersion: base.version, baseWorkflowId: base.workflowId } : {}) },
    });
    this.#event(workflow.id, {
      type: 'workflow.created',
      category: 'workflow',
      summary: `Workflow created. Team availability: ${team.map((a) => `${a.label} ${a.enabled ? 'enabled' : 'disabled'}`).join(', ')}.`,
      detail: { team, productDir: this.productDir(workflow.id) },
    });

    return { workflow: this.repository.getWorkflow(workflow.id), done: this.#start(workflow.id) };
  }

  /**
   * Answers the PO's question: the same request goes back to requirement
   * analysis, and the PO receives the whole clarification dialogue so far.
   * @returns {{ workflow: object, done: Promise<object> }}
   */
  answer(workflowId, answerText) {
    const workflow = this.repository.getWorkflow(workflowId);
    if (!workflow) throw new NotFoundError('Workflow not found');
    if (workflow.status !== 'needs_clarification') {
      throw new ConflictError('The PO is not waiting for an answer on this request.');
    }
    if (typeof answerText !== 'string' || answerText.trim().length < 1) throw new ValidationError('Please write your answer to the PO.');
    const text = answerText.trim();
    if (text.length > REQUEST_LIMITS.max) throw new ValidationError(`The answer is too long (${text.length} characters). Please keep it under ${REQUEST_LIMITS.max} characters.`);
    const active = this.repository.findActiveWorkflow();
    if (active || this.current) {
      throw new ConflictError(`"${(active ?? this.repository.getWorkflow(this.current.workflowId)).title}" is in progress. This workspace runs one workflow at a time.`);
    }

    const question = workflow.state.clarification?.message ?? null;
    const dialogue = [...(workflow.state.dialogue ?? []), { question, answer: text }];
    this.#event(workflowId, {
      type: 'clarification.answered',
      category: 'request',
      actor: 'user',
      actorKind: 'human',
      from: 'user',
      to: 'po',
      summary: `Answer to the PO: "${text}"`,
      detail: { answer: text, question, round: dialogue.length },
    });
    this.repository.updateWorkflow(workflowId, {
      status: 'running',
      stage: 'analysis',
      finishedAt: null,
      state: { ...workflow.state, dialogue, clarification: null },
    });
    return { workflow: this.repository.getWorkflow(workflowId), done: this.#start(workflowId) };
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

  /**
   * Deletes a product for good: all its requests with their tasks and events,
   * and its folder (files and Git history). productId null deletes every
   * product and all recorded activity. A running workflow cannot be deleted.
   * @returns {Promise<{ deletedWorkflows: string[] }>}
   */
  async deleteProduct(productId) {
    if (productId != null && !this.repository.listProductWorkflows(productId).length) throw new NotFoundError('This product does not exist.');
    const running = this.current && this.repository.getWorkflow(this.current.workflowId);
    if (running && (productId == null || running.productId === productId)) {
      throw new ConflictError(`"${running.title}" is still running. Wait for it to finish (or until it is blocked) before deleting it.`);
    }
    const deletedWorkflows = this.repository.deleteWorkflows(productId);
    const folders = productId == null ? [join(this.dataDir, 'workflows')] : [join(this.dataDir, 'workflows', productId)];
    for (const folder of folders) await rm(folder, { recursive: true, force: true });
    for (const id of deletedWorkflows) this.gitNoticeSent.delete(id);
    return { deletedWorkflows };
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

  /**
   * Switches how an agent decides: 'scripted' (rules) or 'ai' (Claude Code).
   * Like enable/disable, it applies to the next assignment.
   * @returns {{ changed: boolean }}
   */
  setAgentMode(agentId, mode, { modelName } = {}) {
    if (!this.team.has(agentId)) throw new NotFoundError(`Unknown agent "${agentId}"`);
    if (mode !== 'scripted' && mode !== 'ai') throw new ValidationError('"mode" must be "scripted" or "ai"');
    if (mode === 'ai' && !this.team.supportsAi?.(agentId)) {
      throw new ValidationError(`${this.label(agentId)} has no AI-powered version in this workspace.`);
    }
    if (this.repository.getAgentMode(agentId) === mode) return { changed: false };
    this.repository.setAgentMode(agentId, mode);
    const active = this.repository.findActiveWorkflow();
    const running = this.repository.listRunningTasks().find((t) => t.agentId === agentId);
    this.#event(active?.id ?? null, {
      type: 'agent.mode',
      category: 'config',
      actor: 'user',
      actorKind: 'human',
      status: 'info',
      summary:
        `${this.label(agentId)} switched to ${mode === 'ai' ? `AI-powered (Claude Code${modelName ? `, ${modelName}` : ''})` : 'scripted (rules and templates, no AI)'}.` +
        (running ? ` Its current task finishes in the previous mode.` : ''),
      detail: { agentId, mode, model: mode === 'ai' ? modelName ?? null : null },
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
      detail: { stage: stage.id, agentId: agent.id, cause: 'agent_disabled' },
    });
  }

  #blockOnError(workflow, stage, agent, error) {
    const ai = error.cause === 'ai_unavailable';
    const reason = `${stage.title} is blocked: ${agent.label}${ai ? ' (AI)' : ''} could not do its work. ${error.message}`;
    this.repository.updateWorkflow(workflow.id, { status: 'blocked', blockedReason: reason, verified: false });
    this.#event(workflow.id, {
      type: 'workflow.blocked',
      category: 'workflow',
      status: 'warning',
      summary: `${reason} Fix the cause, then click Resume to run this stage again.`,
      error: error.message,
      detail: { stage: stage.id, agentId: agent.id, cause: error.cause ?? 'agent_unavailable', kind: error.kind ?? null },
    });
  }

  /** Records each model request an AI agent made, with its real outcome. */
  #recordAiCalls(ctx, calls) {
    for (const call of calls ?? []) {
      const tokens = call.usage?.promptTokens != null ? `, ${call.usage.promptTokens} → ${call.usage.completionTokens ?? '?'} tokens` : '';
      const time = call.durationMs != null ? ` in ${formatMs(call.durationMs)}` : '';
      ctx.say({
        type: 'ai.call',
        category: 'ai',
        status: call.ok ? 'success' : 'failure',
        summary: call.ok
          ? `${ctx.agent.label} asked ${call.model} via Claude Code to ${call.purpose}${time}${tokens}.`
          : `${ctx.agent.label}'s request to ${call.model} (${call.purpose}, attempt ${call.attempt}) failed: ${call.error}`,
        detail: call,
        error: call.ok ? null : call.error,
      });
    }
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
    ctx.say({ type: 'task.started', summary: `${agent.label}${agent.kind === 'ai' ? ' (AI-powered)' : ''} started: ${stage.taskTitle.toLowerCase()}.` });

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
      this.#recordAiCalls(ctx, error.aiCalls);
      if (error.blocking) {
        this.#blockOnError(workflow, stage, agent, error);
        return;
      }
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
    const base = workflow.state.base ?? null;
    const dialogue = workflow.state.dialogue ?? [];
    const result = await agent.analyse({ requestText: workflow.requestText, recipes: this.recipes, current: base, dialogue });
    this.#recordAiCalls(ctx, result.aiCalls);

    if (result.status === 'needs_clarification') {
      say({
        type: 'po.clarification',
        from: agent.id,
        to: 'user',
        status: 'warning',
        summary: result.message,
        detail: { reason: result.reason, supported: result.supported, questions: result.questions ?? null, round: (workflow.state.dialogue ?? []).length + 1 },
      });
      this.#event(workflow.id, {
        type: 'workflow.needs_clarification',
        category: 'workflow',
        status: 'warning',
        summary: 'The PO is waiting for your answer. Answer below to continue this same request.',
      });
      return {
        output: { summary: result.summary, status: result.status },
        update: {
          status: 'needs_clarification',
          title: base ? base.spec.title : 'Request needs clarification',
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
        version: spec.version,
        changes: spec.changes ?? null,
        assumptions: spec.assumptions ?? null,
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
    // Rework after the PO rejected a verified product, or a correction of QA's defects.
    const defects = correcting ? (state.poFeedback ?? state.verification?.defects ?? []) : [];

    const changing = Boolean(state.base);
    const currentFiles =
      correcting || changing ? (await this.listProductFiles(workflow.id)).files.filter((f) => f.content != null && !isQaFile(f.path)) : [];
    const result = await agent.implement({ spec: state.spec, attempt, defects, currentFiles, change: changing ? { previousSpec: state.base.spec } : null });
    this.#recordAiCalls(ctx, result.aiCalls);
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
    const productFiles = (await this.listProductFiles(workflow.id)).files.filter((f) => f.content != null && !isQaFile(f.path));
    const plan = await agent.planVerification({ spec: state.spec, implementation: state.implementation, dialogue: state.dialogue ?? [], files: productFiles });
    this.#recordAiCalls(ctx, plan.aiCalls);
    say({
      type: 'qa.plan',
      summary: plan.summary,
      detail: { commands: plan.commands.map((c) => ({ label: c.label, command: `node ${sandboxArgs(c, dir).join(' ')}` })) },
    });
    await this.#writeFiles(ctx, [plan.testFile, ...(plan.extraFiles ?? [])]);
    for (const concern of plan.concerns ?? []) {
      say({ type: 'qa.concern', category: 'test', from: agent.id, to: 'po', status: 'warning', summary: concern, detail: { concern } });
    }

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
    if (evaluation.aiTests?.problem) {
      say({
        type: 'qa.ai-tests-failed',
        status: 'warning',
        summary: "QA's own (AI-written) tests could not run, so they count neither for nor against the product. The deterministic checks decide.",
        error: evaluation.aiTests.problem,
      });
    }
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
      aiTests: evaluation.aiTests ?? null,
      concerns: plan.concerns ?? [],
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
      update: { stage: next, verified: false, state: { ...state, verification, poFeedback: null } },
    };
  }

  async #review(ctx) {
    const { workflow, agent, say } = ctx;
    const state = workflow.state;
    const files = (await this.listProductFiles(workflow.id)).files.filter((f) => f.content != null && !isQaFile(f.path));
    const rejections = state.poRejections ?? [];
    const review = await agent.review({ spec: state.spec, verification: state.verification ?? null, files, previousRejections: rejections });
    this.#recordAiCalls(ctx, review.aiCalls);
    const { aiCalls: _calls, ...decision } = review;
    const qaPassed = state.verification?.verdict === 'pass';
    // A PO rejecting a product QA verified sends it back to the Developer,
    // like QA's defects, while implementation attempts remain.
    const rework = !review.accepted && qaPassed && state.attempt < MAX_IMPLEMENTATION_ATTEMPTS;
    say({
      type: 'po.review',
      status: review.accepted ? 'success' : rework ? 'warning' : 'failure',
      summary: review.summary,
      detail: { unmet: review.unmet, decidedBy: review.decidedBy ?? null, reasons: review.reasons ?? [], rework },
    });

    if (rework) {
      const reasons = review.reasons?.length ? review.reasons : [review.summary];
      const poFeedback = reasons.map((reason) => ({ title: reason, reportedBy: 'PO', detail: review.summary }));
      say({
        type: 'handoff',
        category: 'handoff',
        from: agent.id,
        to: 'dev',
        status: 'failure',
        summary: `Not accepted yet: ${review.summary} Please rework the product (attempt ${state.attempt + 1} of ${MAX_IMPLEMENTATION_ATTEMPTS}); QA will verify it again.`,
        detail: { defects: reasons },
      });
      return {
        output: { summary: review.summary, accepted: false, rework: true },
        update: {
          stage: 'correction',
          verified: false,
          state: { ...state, review: decision, poFeedback, poRejections: [...rejections, { attempt: state.attempt, summary: review.summary, reasons }] },
        },
      };
    }

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
        state: { ...state, review: decision },
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
    const args = sandboxArgs(command, dir);
    const display = `node ${args.join(' ')}`;
    say({ type: 'command.started', category: 'command', summary: `${command.label}: ${display}`, detail: { command: display, cwd: dir } });
    const run = await runCommand({ command: process.execPath, args, cwd: dir, timeoutMs: this.commandTimeoutMs });
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

    if (command.kind === 'ai-tests') {
      const { tests, summary } = parseTap(run.stdout);
      result.tests = tests.filter((t) => !t.suite);
      result.summary = summary;
      say({
        type: 'qa.ai-tests',
        category: 'test',
        status: summary.fail === 0 && summary.tests > 0 && run.exitCode === 0 ? 'success' : 'failure',
        summary: `QA (AI) tests: ${summary.tests ?? 0} tests, ${summary.pass ?? 0} passed, ${summary.fail ?? 0} failed (read-only access to the product folder).`,
        detail: { summary, tests: result.tests, exitCode: run.exitCode },
      });
    }
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

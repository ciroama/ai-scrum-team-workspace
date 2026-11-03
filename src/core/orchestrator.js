import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { resolveInside, writeFile } from '../actions/writeFile.js';
import { runCommand } from '../actions/runCommand.js';
import { parseTap } from '../actions/tapParser.js';
import { commitAll, detectGit } from '../actions/git.js';
import { stopAll } from '../actions/children.js';
import { RECIPES } from '../recipes/index.js';
import { MAX_IMPLEMENTATION_ATTEMPTS, STAGES } from './stages.js';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export const REQUEST_LIMITS = { min: 3, max: 2000 };

/**
 * Version of the team's working rules, recorded on every request so that
 * experiments run under different rules can be compared.
 * 1: the Developer and QA could not ask questions; the PO read the code in its review.
 * 2: the Developer and QA may ask the PO (who answers or passes the question
 *    on to the user); the PO never reads the code.
 * 3: as 2, and the PO writes its acceptance criteria in words: QA decides
 *    how to test each one.
 * 4: as 3, and a product with behaviour keeps its rules in logic.js, which
 *    loads without a browser: QA tests the behaviour through it.
 * 5: as 4, and the PO's final review sees the user's answers; when the PO
 *    finds its own requirements wrong, it corrects them before any rework
 *    (the Developer never changes the requirements).
 */
export const TEAM_RULES_VERSION = 5;

/** How many times the PO may correct its own requirements in one request. */
const MAX_REVISIONS = 2;
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
  consultation: 'analysis',
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
  constructor({ repository, team, dataDir, recipes = RECIPES, gitBinary = 'git', commandTimeoutMs = 60_000, modelOf = () => null }) {
    /** The model each agent would use if AI-powered (for the record of each request). */
    this.modelOf = modelOf;
    this.repository = repository;
    this.team = team;
    // Absolute: commands run inside the product folder, where a relative path would point somewhere else.
    this.dataDir = resolve(dataDir);
    this.recipes = recipes;
    this.gitBinary = gitBinary;
    this.commandTimeoutMs = commandTimeoutMs;
    /** @type {{ workflowId: string, promise: Promise<object> } | null} */
    this.current = null;
    /** The workflow the user asked to stop, while its current step winds down. */
    this.stopping = null;
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
    return latest
      ? { workflowId: latest.id, version: latest.state.spec.version ?? versions.length, spec: latest.state.spec, status: latest.status, verified: latest.verified }
      : null;
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
  submit(requestText, { productId = null, type = null } = {}) {
    // What brings the user back to a product: a bug (it does not work as
    // agreed) or a change request (something new or different).
    if (type != null && type !== 'bug' && type !== 'change') throw new ValidationError('"type" must be "bug" or "change".');
    if (type != null && productId == null) throw new ValidationError('A bug report or change request needs the product it is about.');
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
      state: { ...(base ? { base, requestType: type ?? 'change' } : {}), rules: { version: TEAM_RULES_VERSION } },
    });
    const requestType = base ? type ?? 'change' : null;
    const config = this.repository.getAgentConfig();
    const team = [...this.team.values()].map((a) => ({
      id: a.id,
      label: a.label,
      kind: a.kind,
      enabled: config[a.id]?.enabled ?? false,
      model: a.kind === 'ai' ? this.modelOf(a.id) : null,
    }));

    this.#event(workflow.id, {
      type: 'request.submitted',
      category: 'request',
      actor: 'user',
      actorKind: 'human',
      summary: base
        ? `${requestType === 'bug' ? 'Bug report' : 'Change request'} for "${base.spec.title}" (requirements v${base.version}): "${text}"`
        : `Requirement submitted: "${text}"`,
      detail: {
        requestText: text,
        ...(base ? { productId, requestType, baseVersion: base.version, baseWorkflowId: base.workflowId, baseVerified: base.verified } : {}),
      },
    });
    this.#event(workflow.id, {
      type: 'workflow.created',
      category: 'workflow',
      summary: `Workflow created. Team availability: ${team.map((a) => `${a.label} ${a.enabled ? 'enabled' : 'disabled'}`).join(', ')}.`,
      detail: { team, productDir: this.productDir(workflow.id), rules: { version: TEAM_RULES_VERSION } },
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
      throw new ConflictError('The team is not waiting for an answer on this request.');
    }
    if (typeof answerText !== 'string' || answerText.trim().length < 1) throw new ValidationError('Please write your answer.');
    const text = answerText.trim();
    if (text.length > REQUEST_LIMITS.max) throw new ValidationError(`The answer is too long (${text.length} characters). Please keep it under ${REQUEST_LIMITS.max} characters.`);
    this.#assertIdle();
    const state = workflow.state;
    const user = { actor: 'user', actorKind: 'human', from: 'user' };

    if (state.waitingFor === 'team') {
      // A question the PO passed on: the answer goes to the teammate who asked.
      const pending = state.teamQuestions;
      const question = pending.escalated.map((q) => q.question).join('\n');
      this.#event(workflowId, {
        ...user,
        type: 'team.answered',
        category: 'request',
        to: pending.from,
        summary: `Answer to the ${pending.from === 'dev' ? 'Developer' : 'QA'}: "${text}"`,
        detail: { answer: text, for: pending.from, questions: pending.escalated.map((q) => q.question) },
      });
      this.repository.updateWorkflow(workflowId, {
        status: 'running',
        stage: pending.returnStage,
        finishedAt: null,
        state: { ...state, waitingFor: null, teamQuestions: null, teamClarifications: [...(state.teamClarifications ?? []), { from: pending.from, question, answer: text, answeredBy: 'user' }] },
      });
      return { workflow: this.repository.getWorkflow(workflowId), done: this.#start(workflowId) };
    }

    const question = state.clarification?.message ?? null;
    const dialogue = [...(state.dialogue ?? []), { question, answer: text }];
    this.#event(workflowId, { ...user, type: 'clarification.answered', category: 'request', to: 'po', summary: `Answer to the PO: "${text}"`, detail: { answer: text, question, round: dialogue.length } });
    this.repository.updateWorkflow(workflowId, {
      status: 'running',
      stage: 'analysis',
      finishedAt: null,
      state: { ...state, dialogue, clarification: null, waitingFor: null },
    });
    return { workflow: this.repository.getWorkflow(workflowId), done: this.#start(workflowId) };
  }

  /**
   * Stops the running workflow now: the agent's Claude Code request or test
   * run is ended, and the workflow becomes Interrupted. Resume runs the
   * stopped stage again; Cancel ends it. Earlier work is kept.
   * @returns {{ workflow: object, done: Promise<object> }}
   */
  stop(workflowId) {
    const workflow = this.repository.getWorkflow(workflowId);
    if (!workflow) throw new NotFoundError('Workflow not found');
    if (workflow.status !== 'running' || this.current?.workflowId !== workflowId) {
      throw new ConflictError('Only a running workflow can be stopped.');
    }
    this.stopping = workflowId;
    stopAll();
    return { workflow, done: this.current.promise };
  }

  /** The stage that was running when the user stopped the workflow. */
  #stopped(workflow, stage, agent) {
    this.stopping = null;
    this.repository.updateWorkflow(workflow.id, { status: 'interrupted', verified: false });
    this.#event(workflow.id, {
      type: 'workflow.stopped',
      category: 'workflow',
      actor: 'user',
      actorKind: 'human',
      status: 'warning',
      summary: `You stopped the workflow during ${stage.title} (${agent.label} was working). Resume runs this stage again; earlier work is kept. Or cancel the workflow.`,
      detail: { stage: stage.id, agentId: agent.id },
    });
  }

  /** One workflow at a time: refuses to continue a request while another runs. */
  #assertIdle() {
    const active = this.repository.findActiveWorkflow();
    if (active || this.current) {
      throw new ConflictError(`"${(active ?? this.repository.getWorkflow(this.current.workflowId)).title}" is in progress. This workspace runs one workflow at a time.`);
    }
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

  /**
   * Chooses the model an AI-powered agent uses (null: the workspace default).
   * Like the other settings, it applies to the next assignment.
   * @returns {{ changed: boolean }}
   */
  setAgentModel(agentId, model, { defaultModel } = {}) {
    if (!this.team.has(agentId)) throw new NotFoundError(`Unknown agent "${agentId}"`);
    if (!this.team.supportsAi?.(agentId)) throw new ValidationError(`${this.label(agentId)} has no AI-powered version in this workspace.`);
    if (this.repository.getAgentModel(agentId) === (model || null)) return { changed: false };
    this.repository.setAgentModel(agentId, model);
    const active = this.repository.findActiveWorkflow();
    this.#event(active?.id ?? null, {
      type: 'agent.model',
      category: 'config',
      actor: 'user',
      actorKind: 'human',
      status: 'info',
      summary: `${this.label(agentId)} now uses ${model ? `the model "${model}"` : `the workspace default model${defaultModel ? ` ("${defaultModel}")` : ''}`} when AI-powered.`,
      detail: { agentId, model: model || null, defaultModel: defaultModel ?? null },
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
        if (this.stopping === workflowId) this.#stopped(workflow, stage, agent);
        // Availability is checked before every assignment.
        else if (!this.repository.isAgentEnabled(agent.id)) this.#block(workflow, stage, agent);
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
        consultation: () => this.#consultation(ctx),
      }[stage.id];
      const { output, update } = await handler();
      if (this.stopping === workflow.id) {
        // Stopped while the step was finishing: its result is not used.
        this.repository.finishTask(task.id, { status: 'interrupted', error: 'Stopped by you' });
        this.#stopped(workflow, stage, agent);
        return;
      }
      this.repository.finishTask(task.id, { status: 'completed', output });
      this.repository.updateWorkflow(workflow.id, update);
    } catch (error) {
      if (this.stopping === workflow.id) {
        this.repository.finishTask(task.id, { status: 'interrupted', error: 'Stopped by you' });
        this.#stopped(workflow, stage, agent);
        return;
      }
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
    // A revision: the PO's own review found its requirements wrong, and it corrects them.
    const revision = workflow.state.revision ?? null;
    const result = await agent.analyse({
      requestText: workflow.requestText,
      recipes: this.recipes,
      current: revision ? { spec: revision.previousSpec, version: revision.previousSpec.version ?? 1 } : base,
      dialogue,
      requestType: workflow.state.requestType ?? null,
      revision: revision?.reasons ?? null,
    });
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
          state: { ...workflow.state, waitingFor: 'po', clarification: { reason: result.reason, message: result.message, supported: result.supported } },
        },
      };
    }

    let { spec } = result;
    if (revision) {
      // A corrected version of the same request: it keeps what kind of request it is.
      const { requestType: _type, bugOrigin: _origin, ...rest } = spec;
      const previous = revision.previousSpec;
      spec = { ...rest, ...(previous.requestType ? { requestType: previous.requestType } : {}), ...(previous.bugOrigin ? { bugOrigin: previous.bugOrigin } : {}), correctedAfterReview: true };
    }
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
        bugOrigin: spec.bugOrigin ?? null,
        whyNoQuestions: spec.whyNoQuestions ?? null,
      },
    });
    const handoff = { message: result.handoffMessage, references: [result.document.path, ...spec.acceptanceCriteria.map((c) => c.id)] };
    say({ type: 'handoff', category: 'handoff', from: agent.id, to: 'dev', summary: handoff.message, detail: { references: handoff.references } });
    return {
      output: { summary: result.summary, recipeId: spec.recipeId },
      update: revision
        ? // The Developer changes the existing product to the corrected requirements; its attempts are not reset.
          { title: spec.title, stage: 'implementation', state: { ...workflow.state, spec, revision: null, previousSpec: revision.previousSpec } }
        : { recipeId: spec.recipeId, title: spec.title, stage: 'implementation', state: { ...workflow.state, spec, attempt: 0 } },
    };
  }

  async #implementation(ctx) {
    const { workflow, stage, agent, say } = ctx;
    const state = workflow.state;
    const attempt = (state.attempt ?? 0) + 1;
    const correcting = stage.id === 'correction';
    // Rework after the PO rejected a verified product, or a correction of QA's defects.
    const defects = correcting ? (state.poFeedback ?? state.verification?.defects ?? []) : [];

    // A change request, or requirements the PO corrected: the existing product changes.
    const changing = Boolean(state.base) || Boolean(state.previousSpec);
    const currentFiles =
      correcting || changing ? (await this.listProductFiles(workflow.id)).files.filter((f) => f.content != null && !isQaFile(f.path)) : [];
    const askKey = `dev:${stage.id}:${attempt}`;
    const result = await agent.implement({
      spec: state.spec,
      attempt,
      defects,
      currentFiles,
      change: changing ? { previousSpec: state.previousSpec ?? state.base.spec } : null,
      canAsk: !state.asked?.[askKey],
      teamClarifications: state.teamClarifications ?? [],
    });
    this.#recordAiCalls(ctx, result.aiCalls);
    if (result.status === 'questions') return this.#asked(ctx, { from: 'dev', askKey, questions: result.questions });
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
      update: { stage: 'verification', verified: false, state: { ...state, attempt, implementation: { files, commit, attempt }, previousSpec: null } },
    };
  }

  async #verification(ctx) {
    const { workflow, agent, dir, say } = ctx;
    const state = workflow.state;
    const productFiles = (await this.listProductFiles(workflow.id)).files.filter((f) => f.content != null && !isQaFile(f.path));
    const askKey = `qa:verification:${state.attempt}`;
    const plan = await agent.planVerification({
      spec: state.spec,
      implementation: state.implementation,
      dialogue: state.dialogue ?? [],
      files: productFiles,
      canAsk: !state.asked?.[askKey],
      teamClarifications: state.teamClarifications ?? [],
      dir: ctx.dir,
    });
    this.#recordAiCalls(ctx, plan.aiCalls);
    if (plan.status === 'questions') return this.#asked(ctx, { from: 'qa', askKey, questions: plan.questions });
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

    const evaluation = await agent.evaluate({ spec: state.spec, results: { missingFiles, commands }, plan });
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
      // Failing the agreed criteria is an implementation problem; QA's own tests say when it is the requirements.
      say({ type: 'defect.reported', category: 'defect', status: 'failure', summary: defect.title, detail: { origin: 'implementation', ...defect } });
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
    const rejections = state.poRejections ?? [];
    // The PO never receives the code: it judges by the request, the requirements and QA's evidence.
    const review = await agent.review({ spec: state.spec, verification: state.verification ?? null, previousRejections: rejections, teamClarifications: state.teamClarifications ?? [], dialogue: state.dialogue ?? [] });
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
      detail: {
        unmet: review.unmet,
        decidedBy: review.decidedBy ?? null,
        reasons: review.reasons ?? [],
        reasonOrigins: review.reasonOrigins ?? [],
        concernResponses: review.concernResponses ?? [],
        rework,
      },
    });

    // The requirements are the PO's: when its review finds them wrong, the PO
    // corrects them first. The Developer never changes the requirements.
    const requirementsWrong = !review.accepted && (review.reasonOrigins ?? []).includes('requirements') && (state.revisions ?? 0) < MAX_REVISIONS;
    if (requirementsWrong) {
      const reasons = review.reasons?.length ? review.reasons : [review.summary];
      say({
        type: 'po.revision',
        from: agent.id,
        to: agent.id,
        status: 'warning',
        summary: `Not accepted yet: the requirements themselves are wrong, so the PO corrects them before the Developer changes the product. ${review.summary}`,
        detail: { reasons, origins: review.reasonOrigins ?? [] },
      });
      return {
        output: { summary: review.summary, accepted: false, revision: true },
        update: {
          stage: 'analysis',
          verified: false,
          state: { ...state, review: decision, revision: { reasons, previousSpec: state.spec }, revisions: (state.revisions ?? 0) + 1, poRejections: [...rejections, { attempt: state.attempt, summary: review.summary, reasons }] },
        },
      };
    }

    if (rework) {
      const reasons = review.reasons?.length ? review.reasons : [review.summary];
      const poFeedback = reasons.map((reason, i) => ({ title: reason, reportedBy: 'PO', detail: review.summary, origin: review.reasonOrigins?.[i] ?? null }));
      say({
        type: 'handoff',
        category: 'handoff',
        from: agent.id,
        to: 'dev',
        status: 'failure',
        summary: `Not accepted yet: ${review.summary} Please rework the product (attempt ${state.attempt + 1} of ${MAX_IMPLEMENTATION_ATTEMPTS}); QA will verify it again.`,
        detail: { defects: reasons, origins: poFeedback.map((f) => f.origin) },
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

  /** A Developer or QA asked the PO before doing its work: the PO answers next. */
  #asked(ctx, { from, askKey, questions }) {
    const { workflow, stage, say } = ctx;
    const who = from === 'dev' ? 'The Developer' : 'QA';
    say({
      type: 'team.question',
      from,
      to: 'po',
      status: 'warning',
      summary: `${who} asked the PO ${questions.length} question${questions.length === 1 ? '' : 's'} before ${from === 'dev' ? 'writing the code' : 'writing its tests'}.`,
      detail: { stage: stage.id, questions },
    });
    return {
      output: { summary: `Asked the PO ${questions.length} question(s).`, questions: questions.length },
      update: {
        stage: 'consultation',
        state: { ...workflow.state, asked: { ...(workflow.state.asked ?? {}), [askKey]: true }, teamQuestions: { from, returnStage: stage.id, questions } },
      },
    };
  }

  /** The PO answers the Developer's or QA's questions, or passes them on to the user. */
  async #consultation(ctx) {
    const { workflow, agent, say } = ctx;
    const state = workflow.state;
    const pending = state.teamQuestions;
    const asker = pending.from === 'dev' ? 'Developer' : 'QA';
    const result = await agent.answerTeam({ spec: state.spec, from: pending.from, questions: pending.questions, dialogue: state.dialogue ?? [], teamClarifications: state.teamClarifications ?? [] });
    this.#recordAiCalls(ctx, result.aiCalls);
    const answered = result.answers.filter((a) => !a.askUser).map((a) => ({ from: pending.from, question: pending.questions[a.question - 1].question, answer: a.answer, answeredBy: 'po' }));
    const escalated = result.answers.filter((a) => a.askUser).map((a) => ({ ...pending.questions[a.question - 1], poWhy: a.why }));
    const teamClarifications = [...(state.teamClarifications ?? []), ...answered];
    if (answered.length) {
      say({
        type: 'team.answer',
        from: agent.id,
        to: pending.from,
        status: 'success',
        summary: `The PO answered ${answered.length} of the ${asker}'s ${pending.questions.length} question${pending.questions.length === 1 ? '' : 's'}.`,
        detail: { answers: answered.map(({ question, answer }) => ({ question, answer })), decidedBy: result.decidedBy ?? null },
      });
    }
    if (!escalated.length) {
      return {
        output: { summary: `Answered all ${answered.length} question(s).`, answered: answered.length, passedOn: 0 },
        update: { stage: pending.returnStage, state: { ...state, teamClarifications, teamQuestions: null } },
      };
    }
    say({
      type: 'po.escalation',
      from: agent.id,
      to: 'user',
      status: 'warning',
      summary: `The ${asker} asked something only you can decide. The PO passes ${escalated.length === 1 ? 'this question' : `these ${escalated.length} questions`} on to you.`,
      detail: { for: pending.from, questions: escalated },
    });
    this.#event(workflow.id, { type: 'workflow.needs_clarification', category: 'workflow', status: 'warning', summary: `The ${asker} is waiting for your answer. Answer below to continue this same request.` });
    return {
      output: { summary: `Answered ${answered.length}, passed ${escalated.length} on to the user.`, answered: answered.length, passedOn: escalated.length },
      update: { status: 'needs_clarification', finishedAt: now(), state: { ...state, teamClarifications, waitingFor: 'team', teamQuestions: { ...pending, escalated } } },
    };
  }

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

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFile } from '../actions/writeFile.js';
import { runCommand } from '../actions/runCommand.js';
import { parseTap } from '../actions/tapParser.js';
import { RUN_MODES, WORKFLOWS } from './workflows.js';

export class ConflictError extends Error {}

/**
 * Runs workflows for stories. Agents decide what to do; the orchestrator
 * executes their actions for real and records each step as an event.
 */
export class Orchestrator {
  /**
   * @param {object} deps
   * @param {import('../storage/repository.js').Repository} deps.repository
   * @param {Map<string, import('../agents/agent.js').Agent>} deps.team
   * @param {string} deps.dataDir
   * @param {number} [deps.testTimeoutMs]
   */
  constructor({ repository, team, dataDir, testTimeoutMs = 60_000 }) {
    this.repository = repository;
    this.team = team;
    this.dataDir = dataDir;
    this.testTimeoutMs = testTimeoutMs;
    /** @type {Map<string, Promise<object>>} storyId -> running workflow */
    this.active = new Map();
  }

  workspaceDir(runId) {
    return join(this.dataDir, 'runs', runId, 'workspace');
  }

  /**
   * Starts a run in the background.
   * @returns {{ run: object, done: Promise<object> }} `done` resolves with the finished run
   */
  startRun(storyId, { mode = 'standard' } = {}) {
    const story = this.repository.getStory(storyId);
    if (!story) throw new Error(`Unknown story ${storyId}`);
    if (!WORKFLOWS[story.workflow]) throw new Error(`No workflow "${story.workflow}"`);
    if (!(mode in RUN_MODES)) throw new Error(`Unknown run mode "${mode}"`);
    if (this.active.has(storyId)) throw new ConflictError(`A run is already in progress for ${storyId}`);

    const run = this.repository.createRun({ storyId, mode });
    const done = this.#execute(run, story).finally(() => this.active.delete(storyId));
    this.active.set(storyId, done);
    return { run, done };
  }

  async #execute(run, story) {
    const workflow = WORKFLOWS[story.workflow];
    const workspaceDir = this.workspaceDir(run.id);
    const emit = (event) => this.repository.appendEvent(run.id, event);
    const context = { story, mode: run.mode, workspaceDir };

    try {
      await mkdir(workspaceDir, { recursive: true });
      emit({
        type: 'run.started',
        payload: {
          storyId: story.id,
          storyTitle: story.title,
          workflow: workflow.id,
          mode: run.mode,
          steps: workflow.steps,
          workspaceDir,
        },
      });
      this.repository.updateStory(story.id, { status: 'in_progress' });
      emit({ type: 'story.updated', payload: { storyId: story.id, status: 'in_progress' } });

      for (const step of workflow.steps) {
        await this.#runStep(step, context, emit);
        if (context.acceptance) this.repository.updateStory(story.id, { acceptance: context.acceptance });
      }

      const status = context.runStatus ?? 'failed';
      this.repository.updateStory(story.id, { status: context.storyStatus, acceptance: context.acceptance });
      emit({ type: 'story.updated', payload: { storyId: story.id, status: context.storyStatus } });

      const summary = {
        verdict: context.verdict,
        tests: context.testRun?.summary ?? null,
        exitCode: context.testRun?.exitCode ?? null,
        files: context.files ?? [],
      };
      emit({ type: 'run.completed', payload: { status, ...summary } });
      return this.repository.finishRun(run.id, { status, summary });
    } catch (error) {
      emit({ type: 'run.error', payload: { message: error.message } });
      this.repository.updateStory(story.id, { status: 'failed' });
      emit({ type: 'story.updated', payload: { storyId: story.id, status: 'failed' } });
      return this.repository.finishRun(run.id, { status: 'error', summary: { error: error.message } });
    }
  }

  async #runStep(step, context, emit) {
    const agent = this.team.get(step.agent);
    if (!agent) throw new Error(`No agent "${step.agent}" in the team`);
    const attribution = { step: step.id, agentId: agent.id, agentKind: agent.kind };
    const say = (messages = []) => {
      for (const text of messages) emit({ ...attribution, type: 'agent.message', payload: { text } });
    };

    emit({ ...attribution, type: 'step.started', payload: { title: step.title } });
    const task = { step: step.id, story: context.story, mode: context.mode };

    const decision = await agent.perform(task, context);
    say(decision.messages);
    Object.assign(context, decision.output);

    const actionResults = [];
    for (const action of decision.actions ?? []) {
      actionResults.push(await this.#executeAction(action, context, attribution, emit));
    }

    if (actionResults.length) {
      const review = await agent.review(task, context, actionResults);
      say(review.messages);
      Object.assign(context, review.output);
    }

    emit({ ...attribution, type: 'step.completed', payload: { title: step.title } });
  }

  async #executeAction(action, context, attribution, emit) {
    switch (action.type) {
      case 'writeFile': {
        const result = await writeFile(context.workspaceDir, action.path, action.content);
        (context.files ??= []).push(result.path);
        emit({ ...attribution, type: 'file.written', payload: { ...result, purpose: action.purpose } });
        return { type: 'writeFile', ...result };
      }
      case 'runTests': {
        const command = process.execPath;
        const args = ['--test', '--test-reporter=tap', ...action.files];
        emit({
          ...attribution,
          type: 'command.started',
          payload: { command: 'node', args, cwd: context.workspaceDir },
        });
        const result = await runCommand({
          command,
          args,
          cwd: context.workspaceDir,
          timeoutMs: this.testTimeoutMs,
          onLine: (stream, line) => emit({ ...attribution, type: 'command.output', payload: { stream, line } }),
        });
        emit({
          ...attribution,
          type: 'command.exited',
          payload: { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, durationMs: result.durationMs },
        });

        const { tests, summary } = parseTap(result.stdout);
        for (const test of tests.filter((t) => !t.suite)) {
          emit({ ...attribution, type: 'test.result', payload: test });
        }
        emit({ ...attribution, type: 'test.summary', payload: { ...summary, exitCode: result.exitCode } });

        context.testRun = { summary, tests, exitCode: result.exitCode };
        return { type: 'runTests', summary, tests, exitCode: result.exitCode, timedOut: result.timedOut };
      }
      default:
        throw new Error(`Unknown action type "${action.type}"`);
    }
  }
}

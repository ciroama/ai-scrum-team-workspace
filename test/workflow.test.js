import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../src/storage/database.js';
import { Repository } from '../src/storage/repository.js';
import { Orchestrator, ConflictError } from '../src/core/orchestrator.js';
import { SEED_STORIES } from '../src/core/workflows.js';
import { createTeam } from '../src/agents/team.js';
import { tempDir } from './helpers.js';

const STORY_ID = SEED_STORIES[0].id;

async function setup(t) {
  const dataDir = await tempDir(t);
  const db = openDatabase(join(dataDir, 'workspace.db'));
  t.after(() => db.close());
  const repository = new Repository(db);
  for (const story of SEED_STORIES) repository.ensureStory(story);
  const orchestrator = new Orchestrator({ repository, team: createTeam(), dataDir });
  return { repository, orchestrator };
}

test('standard run: real files, real test execution, story accepted', async (t) => {
  const { repository, orchestrator } = await setup(t);
  const { run, done } = orchestrator.startRun(STORY_ID, { mode: 'standard' });
  const finished = await done;

  assert.equal(finished.status, 'passed');
  assert.equal(repository.getStory(STORY_ID).status, 'done');

  const events = repository.listEvents(run.id);
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'run.started');
  assert.equal(types.at(-1), 'run.completed');
  for (const type of ['step.started', 'agent.message', 'file.written', 'command.started', 'command.output', 'command.exited', 'test.result', 'test.summary']) {
    assert.ok(types.includes(type), `missing ${type} event`);
  }
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), 'sequence numbers are contiguous');

  // Steps run in workflow order and are attributed to scripted PO, Dev and QA agents.
  const steps = events.filter((e) => e.type === 'step.started').map((e) => [e.step, e.agentId, e.agentKind]);
  assert.deepEqual(steps, [
    ['refine', 'po', 'scripted'],
    ['implement', 'dev', 'scripted'],
    ['verify', 'qa', 'scripted'],
    ['accept', 'po', 'scripted'],
  ]);

  // Test results come from the real runner.
  const exited = events.find((e) => e.type === 'command.exited');
  assert.equal(exited.payload.exitCode, 0);
  const results = events.filter((e) => e.type === 'test.result').map((e) => e.payload);
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.status === 'pass' && r.durationMs > 0));
  const summary = events.find((e) => e.type === 'test.summary').payload;
  assert.equal(summary.tests, 3);
  assert.equal(summary.pass, 3);
  assert.equal(summary.fail, 0);

  // Files exist on disk with the content the events describe.
  const workspace = orchestrator.workspaceDir(run.id);
  const hello = await import(pathToFileURL(join(workspace, 'hello.js')).href);
  assert.equal(hello.greet('Ana'), 'Hello, Ana!');
  assert.match(await readFile(join(workspace, 'hello.test.js'), 'utf8'), /AC2/);
  assert.deepEqual(finished.summary.files, ['ACCEPTANCE.md', 'package.json', 'hello.js', 'hello.test.js']);
});

test('faulty run: the injected defect makes a real test fail and the story is rejected', async (t) => {
  const { repository, orchestrator } = await setup(t);
  const { run, done } = orchestrator.startRun(STORY_ID, { mode: 'faulty' });
  const finished = await done;

  assert.equal(finished.status, 'failed');
  assert.equal(repository.getStory(STORY_ID).status, 'failed');

  const events = repository.listEvents(run.id);
  assert.notEqual(events.find((e) => e.type === 'command.exited').payload.exitCode, 0);

  const results = events.filter((e) => e.type === 'test.result').map((e) => e.payload);
  const failed = results.filter((r) => r.status === 'fail');
  assert.equal(failed.length, 1);
  assert.match(failed[0].name, /^AC2/);
  assert.equal(failed[0].expected, 'Hello, Ana!');
  assert.equal(failed[0].actual, 'Hello, World!');
  assert.deepEqual(finished.summary.tests && [finished.summary.tests.pass, finished.summary.tests.fail], [2, 1]);
});

test('only one run per story at a time', async (t) => {
  const { orchestrator } = await setup(t);
  const { done } = orchestrator.startRun(STORY_ID);
  assert.throws(() => orchestrator.startRun(STORY_ID), ConflictError);
  await done;
  await orchestrator.startRun(STORY_ID).done;
});

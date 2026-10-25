import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTeam } from '../src/agents/team.js';
import { ConflictError, ValidationError } from '../src/core/orchestrator.js';
import { DefectiveDeveloper, GatedDeveloper, setup, types } from './helpers.js';

const HELLO = 'Build a simple Hello World web application.';

test('Hello World end to end: real files, real tests, verified and accepted', async (t) => {
  const { repository, orchestrator } = await setup(t);
  const { workflow, done } = orchestrator.submit(HELLO);
  const finished = await done;

  assert.equal(finished.status, 'completed');
  assert.equal(finished.verified, true);
  assert.equal(finished.title, 'Hello World web application');

  const events = repository.listEvents(workflow.id);
  const order = types(events);
  assert.equal(order[0], 'request.submitted');
  assert.equal(order.at(-1), 'workflow.completed');

  // Stages ran in order, each by its responsible scripted agent.
  const tasks = repository.listTasks(workflow.id);
  assert.deepEqual(tasks.map((t) => [t.stage, t.agentId, t.status]), [
    ['analysis', 'po', 'completed'],
    ['implementation', 'dev', 'completed'],
    ['verification', 'qa', 'completed'],
    ['review', 'po', 'completed'],
  ]);
  assert.ok(events.filter((e) => e.actor !== 'user' && e.actor !== 'system').every((e) => e.actorKind === 'scripted'));

  // Handoffs between agents were recorded with their messages.
  const handoffs = events.filter((e) => e.type === 'handoff').map((e) => `${e.from}->${e.to}`);
  assert.deepEqual(handoffs, ['po->dev', 'dev->qa', 'qa->po']);

  // The test results come from the real test runner.
  const results = events.find((e) => e.type === 'test.results').detail;
  assert.equal(results.exitCode, 0);
  assert.equal(results.summary.fail, 0);
  assert.equal(results.summary.pass, results.summary.tests);
  assert.ok(results.summary.tests >= 4);
  assert.ok(results.tests.filter((x) => /^AC\d:/.test(x.name)).length === 4);

  // The product exists on disk, separate from the dashboard.
  const dir = orchestrator.productDir(workflow.id);
  for (const file of ['index.html', 'app.js', 'src/greet.js', 'README.md', 'REQUIREMENTS.md', 'test/acceptance.test.mjs']) {
    assert.ok(existsSync(join(dir, file)), `${file} exists`);
  }
  assert.match(readFileSync(join(dir, 'index.html'), 'utf8'), /<title>Hello World<\/title>/);
  assert.ok(events.some((e) => e.type === 'git.commit' || e.type === 'git.unavailable' || e.type === 'git.failed'));
});

test('unsupported requests get a clarification, not an implementation', async (t) => {
  const { repository, orchestrator } = await setup(t);
  const finished = await orchestrator.submit('Build a futuristic Breakout game').done;

  assert.equal(finished.status, 'needs_clarification');
  assert.equal(finished.verified, false);
  const events = repository.listEvents(finished.id);
  const clarification = events.find((e) => e.type === 'po.clarification');
  assert.equal(clarification.to, 'user');
  assert.match(clarification.summary, /Hello World web application/);
  assert.ok(!types(events).includes('dev.implementation'));
  assert.equal(repository.listTasks(finished.id).length, 1);
});

for (const [agentId, stage, label] of [
  ['po', 'analysis', 'PO'],
  ['dev', 'implementation', 'Developer'],
  ['qa', 'verification', 'QA'],
]) {
  test(`a disabled ${label} blocks the workflow at ${stage}; Resume continues from the saved state`, async (t) => {
    const { repository, orchestrator } = await setup(t);
    orchestrator.setAgentEnabled(agentId, false);

    const blocked = await orchestrator.submit(HELLO).done;
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.stage, stage);
    assert.equal(blocked.verified, false);
    assert.match(blocked.blockedReason, new RegExp(`${label} is disabled`));

    // The disabled agent received no task, and no stage after the block ran.
    const tasksBefore = repository.listTasks(blocked.id);
    assert.ok(!tasksBefore.some((task) => task.agentId === agentId && task.stage === stage));
    if (agentId === 'po') assert.ok(!types(repository.listEvents(blocked.id)).includes('po.requirements'));
    if (agentId === 'qa') assert.ok(!types(repository.listEvents(blocked.id)).includes('qa.verdict'));

    // Resume is refused while the agent is still disabled.
    assert.throws(() => orchestrator.resume(blocked.id), ConflictError);
    // A new workflow cannot start while this one holds the slot.
    assert.throws(() => orchestrator.submit(HELLO), ConflictError);

    orchestrator.setAgentEnabled(agentId, true);
    const finished = await orchestrator.resume(blocked.id).done;
    assert.equal(finished.status, 'completed');
    assert.equal(finished.verified, true);

    // Earlier stages were not redone.
    const tasksAfter = repository.listTasks(blocked.id);
    assert.deepEqual(tasksAfter.slice(0, tasksBefore.length).map((x) => x.id), tasksBefore.map((x) => x.id));
    assert.equal(tasksAfter.filter((x) => x.stage === 'analysis').length, 1);

    const order = types(repository.listTimeline(blocked.id));
    assert.ok(order.indexOf('workflow.blocked') < order.indexOf('agent.enabled'));
    assert.ok(order.indexOf('agent.enabled') < order.indexOf('workflow.resumed'));
  });
}

test('disabling an agent while it works lets the task finish, then it gets no new assignments', async (t) => {
  const dev = new GatedDeveloper();
  const { repository, orchestrator } = await setup(t, { team: createTeam({ dev }) });
  const { workflow, done } = orchestrator.submit(HELLO);
  await dev.started;

  // Disable QA (next in line) and the working Developer.
  orchestrator.setAgentEnabled('qa', false);
  orchestrator.setAgentEnabled('dev', false);
  const devEvent = repository.listEvents(workflow.id).find((e) => e.type === 'agent.disabled' && e.detail.agentId === 'dev');
  assert.match(devEvent.summary, /current task .* will finish safely/);
  assert.equal(devEvent.detail.finishingTask, 'Implement the requirements');

  dev.release();
  const finished = await done;

  const tasks = repository.listTasks(workflow.id);
  assert.equal(tasks.find((x) => x.stage === 'implementation').status, 'completed');
  assert.equal(finished.status, 'blocked');
  assert.equal(finished.stage, 'verification');
  assert.ok(!tasks.some((x) => x.agentId === 'qa'));
});

test('QA finds a real defect, the Developer corrects it and QA re-tests', async (t) => {
  const { repository, orchestrator } = await setup(t, { team: createTeam({ dev: new DefectiveDeveloper(1) }) });
  const finished = await orchestrator.submit(HELLO).done;

  assert.equal(finished.status, 'completed');
  assert.equal(finished.verified, true);
  const events = repository.listEvents(finished.id);
  const tasks = repository.listTasks(finished.id);
  assert.deepEqual(tasks.map((x) => x.stage), ['analysis', 'implementation', 'verification', 'correction', 'verification', 'review']);

  const firstResults = events.filter((e) => e.type === 'test.results')[0].detail;
  assert.ok(firstResults.summary.fail > 0, 'the first test run really failed');
  assert.notEqual(firstResults.exitCode, 0);
  const defects = events.filter((e) => e.type === 'defect.reported');
  assert.ok(defects.some((d) => d.detail.criterionId === 'AC2'));
  const feedback = events.find((e) => e.type === 'handoff' && e.from === 'qa' && e.to === 'dev');
  assert.match(feedback.summary, /Verification failed/);
  assert.ok(types(events).includes('dev.correction'));
  assert.equal(events.filter((e) => e.type === 'test.results').at(-1).detail.summary.fail, 0);
});

test('a defect that is never fixed ends as failed, not verified', async (t) => {
  const { repository, orchestrator } = await setup(t, { team: createTeam({ dev: new DefectiveDeveloper(99) }) });
  const finished = await orchestrator.submit(HELLO).done;

  assert.equal(finished.status, 'failed');
  assert.equal(finished.verified, false);
  const tasks = repository.listTasks(finished.id);
  assert.equal(tasks.filter((x) => x.stage === 'verification').length, 3);
  assert.equal(tasks.at(-1).stage, 'review');
  assert.equal(tasks.at(-1).output.accepted, false);
});

test('a workflow cut off by a shutdown is marked interrupted and can be resumed', async (t) => {
  const first = await setup(t);
  const wf = first.repository.createWorkflow({ requestText: HELLO, stage: 'analysis' });
  first.repository.startTask({ workflowId: wf.id, agentId: 'po', stage: 'analysis', title: 'Analyse the requirement' });

  // Simulate a restart on the same database.
  first.orchestrator.init();
  const interrupted = first.repository.getWorkflow(wf.id);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(first.repository.listTasks(wf.id)[0].status, 'interrupted');
  assert.ok(types(first.repository.listEvents(wf.id)).includes('workflow.interrupted'));

  const finished = await first.orchestrator.resume(wf.id).done;
  assert.equal(finished.status, 'completed');
});

test('blocked workflows can be cancelled, freeing the slot', async (t) => {
  const { orchestrator } = await setup(t);
  orchestrator.setAgentEnabled('dev', false);
  const blocked = await orchestrator.submit(HELLO).done;
  const cancelled = orchestrator.cancel(blocked.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.verified, false);
  assert.throws(() => orchestrator.cancel(blocked.id), ConflictError);
  orchestrator.setAgentEnabled('dev', true);
  assert.equal((await orchestrator.submit(HELLO).done).status, 'completed');
});

test('only one workflow runs at a time', async (t) => {
  const { orchestrator } = await setup(t);
  const { done } = orchestrator.submit(HELLO);
  assert.throws(() => orchestrator.submit(HELLO), /one workflow at a time/);
  await done;
});

test('invalid requests are rejected with clear messages', async (t) => {
  const { orchestrator, repository } = await setup(t);
  assert.throws(() => orchestrator.submit(''), ValidationError);
  assert.throws(() => orchestrator.submit('   '), /describe what you would like to build/);
  assert.throws(() => orchestrator.submit('hi'), /too short/);
  assert.throws(() => orchestrator.submit('x'.repeat(2001)), /too long/);
  assert.throws(() => orchestrator.submit(42), ValidationError);
  assert.equal(repository.listWorkflows().length, 0);
});

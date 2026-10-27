import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAnalytics, parseDateFilter } from '../src/analytics/analytics.js';
import { createTeam } from '../src/agents/team.js';
import { startServer } from '../src/server/app.js';
import { DefectiveDeveloper, setup, tempDir } from './helpers.js';

const HELLO = 'Build a simple Hello World web application.';
const catalogueFor = (team) => ({ agents: [...team.values()].map((a) => ({ id: a.id, label: a.label })) });
const analyse = ({ repository, team }, filter) => computeAnalytics(repository.analyticsSource(), filter, catalogueFor(team));
const kpi = (result, key) => result.kpis.find((k) => k.key === key);
const value = (result, key) => kpi(result, key).value;

test('with no workflows every KPI says there is not enough data', async (t) => {
  const ctx = await setup(t);
  const result = analyse(ctx);
  assert.equal(result.empty, true);
  assert.deepEqual(result.projects, []);
  assert.ok(result.kpis.every((k) => k.value === null), 'no fabricated zeros or rates');
  assert.ok(result.outcomes.every((o) => o.value === 0));
  assert.ok(result.agents.every((a) => a.executionMs === null && a.tasksCompleted === 0));
});

test('metrics come from the recorded workflows, tasks and events of real runs', async (t) => {
  const ctx = await setup(t);
  const { orchestrator, repository } = ctx;

  // 1. completed normally
  await orchestrator.submit(HELLO).done;
  // 2. blocked by QA, then resumed and completed
  orchestrator.setAgentEnabled('qa', false);
  const blockedByQa = await orchestrator.submit(HELLO).done;
  orchestrator.setAgentEnabled('qa', true);
  await orchestrator.resume(blockedByQa.id).done;
  // 3. unsupported request (no project assigned)
  await orchestrator.submit('Build a futuristic Breakout game').done;
  // 4. blocked by the Developer, then cancelled
  orchestrator.setAgentEnabled('dev', false);
  const blockedByDev = await orchestrator.submit(HELLO).done;
  orchestrator.cancel(blockedByDev.id);
  orchestrator.setAgentEnabled('dev', true);

  const all = analyse(ctx);
  assert.equal(all.empty, false);
  assert.equal(value(all, 'total'), 4);
  assert.equal(value(all, 'completed'), 2);
  assert.equal(value(all, 'failed'), 0);
  assert.equal(value(all, 'blocked'), 0);
  assert.equal(value(all, 'successRate'), 1, '2 verified of 2 delivered; cancelled and clarification are not delivered');
  assert.equal(value(all, 'blocks'), 2);
  assert.equal(kpi(all, 'blocks').detail, 'PO 0 · Developer 1 · QA 1');
  assert.equal(value(all, 'corrections'), 0);
  assert.ok(value(all, 'blockedTime') >= 0);
  assert.match(kpi(all, 'blockedTime').detail, /2 ended · 0 still blocked/);
  assert.ok(value(all, 'completionTime') > 0);

  // Test counts equal the sum of the recorded test runs, nothing else.
  const runs = repository.analyticsSource().events.filter((e) => e.type === 'test.results');
  assert.equal(runs.length, 2);
  assert.equal(value(all, 'testsPassed'), runs.reduce((n, e) => n + e.detail.summary.pass, 0));
  assert.equal(value(all, 'testsFailed'), 0);

  // Agent activity equals the recorded tasks.
  const tasks = repository.analyticsSource().tasks;
  for (const agent of all.agents) {
    assert.equal(agent.tasksCompleted, tasks.filter((x) => x.agentId === agent.id && x.status === 'completed').length, agent.id);
  }
  assert.equal(all.agents.find((a) => a.id === 'po').tasksCompleted, 6, '4 analyses + 2 reviews');
  assert.equal(all.agents.find((a) => a.id === 'qa').tasksCompleted, 2);

  // Outcome chart adds up to the total.
  assert.equal(all.outcomes.reduce((n, o) => n + o.value, 0), 4);
  assert.equal(all.outcomes.find((o) => o.key === 'cancelled').value, 1);
  assert.equal(all.outcomes.find((o) => o.key === 'needs_clarification').value, 1);
});

test('the project filter scopes every metric and All Projects never double counts', async (t) => {
  const ctx = await setup(t);
  const product = await ctx.orchestrator.submit(HELLO).done;
  // A change request belongs to the same product (the scripted PO declines it).
  await ctx.orchestrator.submit('Make the text blue', { productId: product.id }).done;
  const other = await ctx.orchestrator.submit('Build a futuristic Breakout game').done;

  const all = analyse(ctx);
  assert.deepEqual(
    all.projects.map((p) => [p.id, p.title, p.workflows]),
    [[other.id, '“Build a futuristic Breakout game”', 1], [product.id, 'Hello World web application', 2]],
  );

  const hello = analyse(ctx, { projectId: product.id });
  const breakout = analyse(ctx, { projectId: other.id });
  assert.equal(value(hello, 'total'), 2);
  assert.equal(value(breakout, 'total'), 1);
  assert.equal(value(breakout, 'testsPassed'), null, 'no QA runs in this project: not enough data');
  assert.equal(value(breakout, 'successRate'), null);
  assert.ok(hello.workflows.every((w) => w.projectId === product.id));

  // Summing the projects gives exactly All Projects.
  for (const key of ['total', 'completed', 'blocks']) {
    assert.equal((value(hello, key) ?? 0) + (value(breakout, key) ?? 0), value(all, key), key);
  }
  assert.equal(value(hello, 'testsPassed'), value(all, 'testsPassed'));
  assert.equal(value(hello, 'total'), 2, 'the change request counts towards its product');
  for (const agent of all.agents) {
    const parts = [hello, breakout].map((r) => r.agents.find((a) => a.id === agent.id).tasksCompleted);
    assert.equal(parts[0] + parts[1], agent.tasksCompleted, agent.id);
  }

  // An unknown project selects nothing.
  assert.equal(analyse(ctx, { projectId: 'no-such-project' }).empty, true);
});

test('correction cycles and failed tests come from a real QA feedback loop', async (t) => {
  const ctx = await setup(t, { team: createTeam({ dev: new DefectiveDeveloper(1) }) });
  await ctx.orchestrator.submit(HELLO).done;
  const result = analyse(ctx);
  assert.equal(value(result, 'corrections'), 1);
  assert.ok(value(result, 'testsFailed') > 0, 'the first run really failed');
  assert.match(kpi(result, 'testsFailed').detail, /^0 in each workflow's latest run$/);
  assert.equal(value(result, 'successRate'), 1);
  assert.equal(result.agents.find((a) => a.id === 'dev').tasksCompleted, 2);
});

test('a failed workflow lowers the success rate and is never counted as verified', async (t) => {
  const ctx = await setup(t, { team: createTeam({ dev: new DefectiveDeveloper(99) }) });
  await ctx.orchestrator.submit(HELLO).done;
  const result = analyse(ctx);
  assert.equal(value(result, 'failed'), 1);
  assert.equal(value(result, 'completed'), 0);
  assert.equal(value(result, 'successRate'), 0);
  assert.equal(value(result, 'completionTime'), null, 'no verified completions: not enough data');
  assert.equal(value(result, 'corrections'), 2, 'feedback after attempts 1 and 2; attempt 3 goes to the PO');
});

test('a workflow blocked by a disabled QA is not counted as verified or delivered', async (t) => {
  const ctx = await setup(t);
  ctx.orchestrator.setAgentEnabled('qa', false);
  await ctx.orchestrator.submit(HELLO).done;
  const result = analyse(ctx);
  assert.equal(value(result, 'blocked'), 1);
  assert.equal(value(result, 'completed'), 0);
  assert.equal(value(result, 'successRate'), null);
  assert.equal(value(result, 'testsPassed'), null);
  assert.equal(value(result, 'blockedTime'), null, 'the block has not ended yet');
  assert.match(kpi(result, 'blockedTime').detail, /0 ended · 1 still blocked/);
});

test('date filters use the submission time; interrupted tasks are excluded from durations', async (t) => {
  const ctx = await setup(t);
  await ctx.orchestrator.submit(HELLO).done;
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  assert.equal(analyse(ctx, { from: future }).empty, true);
  assert.equal(analyse(ctx, { to: past }).empty, true);
  assert.equal(value(analyse(ctx, { from: past, to: future }), 'total'), 1);

  const wf = ctx.repository.createWorkflow({ requestText: HELLO, stage: 'analysis' });
  ctx.repository.startTask({ workflowId: wf.id, agentId: 'po', stage: 'analysis', title: 'Analyse the requirement' });
  ctx.orchestrator.init(); // simulated restart marks it interrupted
  const result = analyse(ctx);
  const po = result.agents.find((a) => a.id === 'po');
  assert.equal(po.tasksInterrupted, 1);
  assert.ok(result.notes.some((n) => /1 task\(s\) cut off by a shutdown are excluded/.test(n)));

  assert.throws(() => parseDateFilter('not a date', 'from'), /must be a date/);
  assert.equal(parseDateFilter('', 'from'), null);
});

test('GET /api/analytics applies the filters and rejects invalid dates', async (t) => {
  const app = await startServer({ port: 0, dataDir: await tempDir(t) });
  t.after(() => app.close());
  const empty = await (await fetch(`${app.url}/api/analytics`)).json();
  assert.equal(empty.empty, true);

  await app.orchestrator.submit(HELLO).done;
  const all = await (await fetch(`${app.url}/api/analytics?project=all`)).json();
  assert.equal(value(all, 'total'), 1);
  const scoped = await (await fetch(`${app.url}/api/analytics?project=wf-no-such-product`)).json();
  assert.equal(scoped.empty, true);
  assert.equal((await fetch(`${app.url}/api/analytics?from=yesterday-ish`)).status, 400);
  assert.ok(all.kpis.every((k) => ['recorded', 'calculated'].includes(k.source) && k.basis));
});

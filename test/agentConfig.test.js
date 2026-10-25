import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDatabase } from '../src/storage/database.js';
import { Repository } from '../src/storage/repository.js';
import { Orchestrator, NotFoundError, ValidationError } from '../src/core/orchestrator.js';
import { describeTeam } from '../src/core/agentActivity.js';
import { createTeam } from '../src/agents/team.js';
import { setup, tempDir } from './helpers.js';

test('agents start enabled', async (t) => {
  const { repository } = await setup(t);
  const config = repository.getAgentConfig();
  assert.deepEqual(Object.keys(config).sort(), ['dev', 'po', 'qa']);
  assert.ok(Object.values(config).every((c) => c.enabled));
});

test('enabling and disabling changes the configuration and records an event', async (t) => {
  const { repository, orchestrator } = await setup(t);
  assert.deepEqual(orchestrator.setAgentEnabled('qa', false), { changed: true });
  assert.equal(repository.isAgentEnabled('qa'), false);
  assert.deepEqual(orchestrator.setAgentEnabled('qa', false), { changed: false }, 'no duplicate event for no change');
  orchestrator.setAgentEnabled('qa', true);

  const events = repository.listWorkspaceEvents();
  assert.deepEqual(events.map((e) => [e.type, e.category, e.actor, e.detail.agentId]), [
    ['agent.disabled', 'config', 'user', 'qa'],
    ['agent.enabled', 'config', 'user', 'qa'],
  ]);
});

test('configuration survives an application restart', async (t) => {
  const dataDir = await tempDir(t);
  const file = join(dataDir, 'workspace.db');

  const first = openDatabase(file).db;
  const o1 = new Orchestrator({ repository: new Repository(first), team: createTeam(), dataDir });
  o1.init();
  o1.setAgentEnabled('po', false);
  first.close();

  const second = openDatabase(file).db;
  t.after(() => second.close());
  const repo2 = new Repository(second);
  new Orchestrator({ repository: repo2, team: createTeam(), dataDir }).init();
  assert.equal(repo2.isAgentEnabled('po'), false);
  assert.equal(repo2.isAgentEnabled('dev'), true);
});

test('rejects unknown agents and non-boolean values', async (t) => {
  const { orchestrator } = await setup(t);
  assert.throws(() => orchestrator.setAgentEnabled('pm', false), NotFoundError);
  assert.throws(() => orchestrator.setAgentEnabled('po', 'no'), ValidationError);
});

test('availability and execution status are reported separately', async (t) => {
  const { repository, orchestrator, team } = await setup(t);
  orchestrator.setAgentEnabled('qa', false);
  const blocked = await orchestrator.submit('Build a Hello World application').done;

  const view = describeTeam({
    team,
    config: repository.getAgentConfig(),
    workflow: blocked,
    tasks: repository.listTasks(blocked.id),
    events: repository.listTimeline(blocked.id),
  });
  const byId = Object.fromEntries(view.map((a) => [a.id, a]));
  assert.equal(byId.qa.enabled, false);
  assert.equal(byId.qa.execution, 'idle');
  assert.match(byId.qa.activity, /Needed to continue/);
  assert.equal(byId.dev.enabled, true);
  assert.equal(byId.dev.execution, 'waiting');
  assert.equal(byId.dev.lastHandoff.to, 'QA');
  assert.ok(view.every((a) => a.execution !== 'working'), 'nobody is working when no task runs');
});

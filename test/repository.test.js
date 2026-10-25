import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { openDatabase } from '../src/storage/database.js';
import { Repository } from '../src/storage/repository.js';
import { tempDir } from './helpers.js';

test('events are stored in order, broadcast, and keep their structure', () => {
  const repo = new Repository(openDatabase(':memory:').db);
  const wf = repo.createWorkflow({ requestText: 'Build it', stage: 'analysis' });
  const broadcast = [];
  repo.on('event', (e) => broadcast.push(e));

  repo.appendEvent({ workflowId: wf.id, type: 'a', category: 'request', actor: 'user', actorKind: 'human', summary: 'first' });
  repo.appendEvent({ workflowId: wf.id, type: 'handoff', category: 'handoff', actor: 'po', actorKind: 'scripted', from: 'po', to: 'dev', summary: 'second', detail: { x: 1 } });

  const events = repo.listEvents(wf.id);
  assert.deepEqual(events.map((e) => e.summary), ['first', 'second']);
  assert.deepEqual([events[1].from, events[1].to, events[1].detail], ['po', 'dev', { x: 1 }]);
  assert.equal(broadcast.length, 2);
});

test('the timeline includes workspace-level events recorded during the workflow', () => {
  const repo = new Repository(openDatabase(':memory:').db);
  const wf = repo.createWorkflow({ requestText: 'Build it', stage: 'analysis' });
  repo.appendEvent({ workflowId: null, type: 'agent.disabled', category: 'config', summary: 'QA disabled' });
  assert.deepEqual(repo.listTimeline(wf.id).map((e) => e.type), ['agent.disabled']);
});

test('workflow state persists across reopening the database', async (t) => {
  const file = join(await tempDir(t), 'workspace.db');
  const first = openDatabase(file).db;
  const repo1 = new Repository(first);
  const wf = repo1.createWorkflow({ requestText: 'Build it', stage: 'analysis' });
  repo1.updateWorkflow(wf.id, { stage: 'verification', state: { spec: { title: 'X' } }, verified: false });
  first.close();

  const second = openDatabase(file).db;
  t.after(() => second.close());
  const again = new Repository(second).getWorkflow(wf.id);
  assert.equal(again.stage, 'verification');
  assert.deepEqual(again.state, { spec: { title: 'X' } });
});

test('a Milestone 1 database is kept as a backup, not deleted or migrated', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'workspace.db');
  const legacy = new DatabaseSync(file);
  legacy.exec('CREATE TABLE stories (id TEXT); INSERT INTO stories VALUES (\'s1\')');
  legacy.close();

  const { db, legacyBackup } = openDatabase(file);
  t.after(() => db.close());
  assert.equal(legacyBackup, join(dir, 'workspace.v1.db'));
  assert.ok(existsSync(legacyBackup));
  const backup = new DatabaseSync(legacyBackup);
  assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM stories').get().n, 1);
  backup.close();
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'workflows'`).get());
});

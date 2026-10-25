import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDatabase } from '../src/storage/database.js';
import { Repository } from '../src/storage/repository.js';
import { tempDir } from './helpers.js';

const STORY = { id: 'story-1', title: 'A story', description: 'Something', workflow: 'hello-world' };

test('events get per-run increasing sequence numbers and are broadcast', () => {
  const repo = new Repository(openDatabase(':memory:'));
  repo.ensureStory(STORY);
  const runA = repo.createRun({ storyId: STORY.id, mode: 'standard' });
  const runB = repo.createRun({ storyId: STORY.id, mode: 'standard' });

  const broadcast = [];
  repo.on('event', (e) => broadcast.push(e));

  repo.appendEvent(runA.id, { type: 'one' });
  repo.appendEvent(runB.id, { type: 'other' });
  repo.appendEvent(runA.id, { type: 'two', agentId: 'qa', agentKind: 'scripted', payload: { n: 2 } });

  const events = repo.listEvents(runA.id);
  assert.deepEqual(events.map((e) => [e.seq, e.type]), [[1, 'one'], [2, 'two']]);
  assert.deepEqual(events[1].payload, { n: 2 });
  assert.equal(events[1].agentKind, 'scripted');
  assert.equal(repo.listEvents(runB.id)[0].seq, 1);
  assert.equal(broadcast.length, 3);
});

test('data survives reopening the database, and unfinished runs are marked interrupted', async (t) => {
  const file = join(await tempDir(t), 'workspace.db');

  const first = openDatabase(file);
  const repo1 = new Repository(first);
  repo1.ensureStory(STORY);
  const run = repo1.createRun({ storyId: STORY.id, mode: 'standard' });
  repo1.appendEvent(run.id, { type: 'run.started' });
  first.close();

  const second = openDatabase(file);
  t.after(() => second.close());
  const repo2 = new Repository(second);
  assert.equal(repo2.listEvents(run.id).length, 1);
  assert.equal(repo2.markInterruptedRuns(), 1);
  assert.equal(repo2.getRun(run.id).status, 'interrupted');
});

test('ensureStory does not overwrite an existing story', () => {
  const repo = new Repository(openDatabase(':memory:'));
  repo.ensureStory(STORY);
  repo.updateStory(STORY.id, { status: 'done' });
  repo.ensureStory({ ...STORY, title: 'Changed' });
  const story = repo.getStory(STORY.id);
  assert.equal(story.status, 'done');
  assert.equal(story.title, 'A story');
});

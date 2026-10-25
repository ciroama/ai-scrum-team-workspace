import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '../src/actions/runCommand.js';
import { commitAll } from '../src/actions/git.js';
import { gitAvailable, setup, tempDir } from './helpers.js';

const git = (args, cwd) => runCommand({ command: 'git', args, cwd });

test('product commits go to the product repository only, never the dashboard repository', async (t) => {
  if (!(await gitAvailable())) return t.skip('git is not available on this machine');

  // An "outer" repository standing in for the dashboard repository.
  const outer = await tempDir(t);
  await git(['init', '-q', outer], outer);
  writeFileSync(join(outer, 'dashboard.txt'), 'dashboard\n');
  await git(['add', '-A'], outer);
  await git(['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'outer'], outer);
  const outerHead = (await git(['rev-parse', 'HEAD'], outer)).stdout.trim();

  const product = join(outer, 'data', 'workflows', 'wf-1', 'product');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(product, { recursive: true });
  writeFileSync(join(product, 'index.html'), '<h1>hi</h1>\n');
  const result = await commitAll({ dir: product, message: 'Product commit' });

  assert.equal(result.ok, true, result.error);
  assert.ok(result.commit);
  assert.ok(existsSync(join(product, '.git')));
  assert.deepEqual(result.files, ['index.html']);

  // The outer repository is untouched: same HEAD, still one commit.
  assert.equal((await git(['rev-parse', 'HEAD'], outer)).stdout.trim(), outerHead);
  assert.equal((await git(['rev-list', '--count', 'HEAD'], outer)).stdout.trim(), '1');
  // The product repository contains only product files.
  const productFiles = (await git([`--git-dir=${join(product, '.git')}`, 'ls-files'], product)).stdout.trim().split('\n');
  assert.deepEqual(productFiles, ['index.html']);
});

test('a full workflow commits the product to its own repository', async (t) => {
  if (!(await gitAvailable())) return t.skip('git is not available on this machine');
  const { repository, orchestrator } = await setup(t);
  const finished = await orchestrator.submit('Build a Hello World application').done;
  const commits = repository.listEvents(finished.id).filter((e) => e.type === 'git.commit');
  assert.equal(commits.length, 2);
  assert.ok(commits.every((c) => c.detail.repository === orchestrator.productDir(finished.id)));
  assert.ok(commits[0].detail.files.includes('index.html'));
});

test('without git the workflow still completes, keeps its files and explains why there is no commit', async (t) => {
  const { repository, orchestrator } = await setup(t, { gitBinary: 'definitely-not-git-binary' });
  const finished = await orchestrator.submit('Build a Hello World application').done;
  assert.equal(finished.status, 'completed');
  const events = repository.listEvents(finished.id);
  assert.ok(!events.some((e) => e.type === 'git.commit'));
  const notice = events.filter((e) => e.type === 'git.unavailable');
  assert.equal(notice.length, 1, 'explained once');
  assert.match(notice[0].summary, /No Git commit was made/);
  assert.ok(existsSync(join(orchestrator.productDir(finished.id), 'index.html')));
});

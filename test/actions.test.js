import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFile } from '../src/actions/writeFile.js';
import { runCommand } from '../src/actions/runCommand.js';
import { tempDir } from './helpers.js';

test('writeFile writes inside the workspace and reports size and hash', async (t) => {
  const dir = await tempDir(t);
  const result = await writeFile(dir, 'nested/a.txt', 'hello');
  assert.equal(await readFile(join(dir, 'nested/a.txt'), 'utf8'), 'hello');
  assert.equal(result.bytes, 5);
  assert.equal(result.sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('writeFile refuses paths outside the workspace', async (t) => {
  const dir = await tempDir(t);
  await assert.rejects(writeFile(dir, '../escape.txt', 'x'), /outside the run workspace/);
  await assert.rejects(writeFile(dir, '/etc/escape.txt', 'x'), /outside the run workspace/);
});

test('runCommand streams lines and reports the real exit code', async (t) => {
  const dir = await tempDir(t);
  const lines = [];
  const result = await runCommand({
    command: process.execPath,
    args: ['-e', 'console.log("one"); console.error("two"); process.exit(3)'],
    cwd: dir,
    onLine: (stream, line) => lines.push([stream, line]),
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
  assert.ok(result.durationMs > 0);
  assert.deepEqual(lines.sort(), [['stderr', 'two'], ['stdout', 'one']]);
});

test('runCommand kills a process that exceeds its timeout', async (t) => {
  const dir = await tempDir(t);
  const result = await runCommand({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 10000)'],
    cwd: dir,
    timeoutMs: 200,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
});

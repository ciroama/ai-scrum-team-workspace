// Local Git support for generated products.
//
// Safety: every command names the product repository explicitly with
// --git-dir and --work-tree, and inherited GIT_* variables are removed.
// Git therefore never searches parent folders, so it cannot read or modify
// the dashboard's own repository even though the product folder lives
// inside it (in the git-ignored data/ folder). Nothing is ever pushed.

import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { childEnv, runCommand } from './runCommand.js';

const COMMIT_IDENTITY = [
  '-c', 'user.name=AI Scrum Team Workspace (scripted agents)',
  '-c', 'user.email=workspace@localhost',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null',
];

function gitEnv() {
  const env = childEnv({ GIT_TERMINAL_PROMPT: '0' });
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT') delete env[key];
  }
  return env;
}

function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

async function run(binary, args, cwd) {
  return runCommand({ command: binary, args, cwd, env: gitEnv(), timeoutMs: 20_000 });
}

/**
 * Checks whether Git can be used.
 *
 * On macOS, /usr/bin/git is a stub until Apple's Command Line Tools are
 * installed, and running it opens an installer dialog. We check for the
 * tools first so the dashboard never triggers that dialog.
 *
 * @returns {Promise<{ available: boolean, version?: string, reason?: string }>}
 */
export async function detectGit({ binary = 'git', cwd = process.cwd() } = {}) {
  try {
    if (process.platform === 'darwin' && binary === 'git') {
      const resolved = onPath('git');
      if (!resolved) return { available: false, reason: 'Git is not installed.' };
      if (resolved === '/usr/bin/git') {
        const tools = await runCommand({ command: 'xcode-select', args: ['-p'], cwd, timeoutMs: 10_000 });
        if (tools.exitCode !== 0) {
          return { available: false, reason: "Apple's Command Line Tools are not installed (install them with: xcode-select --install)." };
        }
      }
    }
    const result = await run(binary, ['--version'], cwd);
    if (result.exitCode !== 0) return { available: false, reason: result.stderr.trim() || `git --version exited with ${result.exitCode}` };
    return { available: true, version: result.stdout.trim() };
  } catch (error) {
    return { available: false, reason: error.code === 'ENOENT' ? 'Git is not installed.' : error.message };
  }
}

/**
 * Commits everything in `dir` to the product's own repository, creating the
 * repository on first use.
 *
 * @returns {Promise<{ ok: true, commit: string | null, initialized: boolean, files: string[] }
 *                 | { ok: false, error: string }>}
 */
export async function commitAll({ binary = 'git', dir, message }) {
  const gitDir = join(dir, '.git');
  const repo = [`--git-dir=${gitDir}`, `--work-tree=${dir}`];
  const fail = (step, result) => ({
    ok: false,
    error: `git ${step} failed (exit code ${result.exitCode}): ${(result.stderr || result.stdout).trim()}`,
  });

  try {
    let initialized = false;
    if (!existsSync(gitDir)) {
      const init = await run(binary, ['-c', 'init.defaultBranch=main', 'init', '-q', dir], dir);
      if (init.exitCode !== 0) return fail('init', init);
      initialized = true;
    }

    const add = await run(binary, [...repo, 'add', '-A'], dir);
    if (add.exitCode !== 0) return fail('add', add);

    const staged = await run(binary, [...repo, 'diff', '--cached', '--name-only'], dir);
    if (staged.exitCode !== 0) return fail('diff', staged);
    const files = staged.stdout.split('\n').filter(Boolean);
    if (files.length === 0) return { ok: true, commit: null, initialized, files };

    const commit = await run(binary, [...COMMIT_IDENTITY, ...repo, 'commit', '-q', '-m', message], dir);
    if (commit.exitCode !== 0) return fail('commit', commit);

    const head = await run(binary, [...repo, 'rev-parse', 'HEAD'], dir);
    if (head.exitCode !== 0) return fail('rev-parse', head);
    return { ok: true, commit: head.stdout.trim(), initialized, files };
  } catch (error) {
    return { ok: false, error: error.code === 'ENOENT' ? 'Git is not installed.' : error.message };
  }
}

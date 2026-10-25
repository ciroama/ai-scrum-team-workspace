import { spawn } from 'node:child_process';

/**
 * Environment for child processes. NODE_TEST_CONTEXT is removed so a
 * `node --test` started from inside another test run (e.g. our own
 * end-to-end tests) reports normally instead of as a nested subtest.
 */
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/**
 * Runs a real child process, streaming each output line as it arrives.
 *
 * @param {object} options
 * @param {string} options.command
 * @param {string[]} options.args
 * @param {string} options.cwd
 * @param {number} [options.timeoutMs]
 * @param {(stream: 'stdout' | 'stderr', line: string) => void} [options.onLine]
 * @returns {Promise<{ exitCode: number | null, signal: string | null, timedOut: boolean,
 *                     durationMs: number, stdout: string, stderr: string }>}
 */
export function runCommand({ command, args, cwd, timeoutMs = 60_000, onLine = () => {} }) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(command, args, { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stdout: '', stderr: '' };
    const pending = { stdout: '', stderr: '' };
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    for (const stream of ['stdout', 'stderr']) {
      child[stream].setEncoding('utf8');
      child[stream].on('data', (chunk) => {
        output[stream] += chunk;
        const lines = (pending[stream] + chunk).split(/\r?\n/);
        pending[stream] = lines.pop();
        for (const line of lines) onLine(stream, line);
      });
    }

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      for (const stream of ['stdout', 'stderr']) {
        if (pending[stream]) onLine(stream, pending[stream]);
      }
      resolve({
        exitCode,
        signal,
        timedOut,
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        ...output,
      });
    });
  });
}

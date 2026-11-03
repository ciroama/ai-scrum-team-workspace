// Every child process the workspace starts (Claude Code, test runs), so they
// can be stopped together: when you click Stop, and when the server exits,
// so no Claude Code request keeps running on its own.

const running = new Set();

/** Registers a child process until it ends. */
export function track(child) {
  running.add(child);
  child.on('close', () => running.delete(child));
  child.on('error', () => running.delete(child));
  return child;
}

/** Stops every running child process; each is marked as stopped on purpose. */
export function stopAll(signal = 'SIGTERM') {
  for (const child of running) {
    child.stoppedOnPurpose = true;
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** How many child processes are running (for tests). */
export const runningCount = () => running.size;

// When the server process ends (Ctrl+C, kill, normal exit), its children end too.
process.on('exit', () => stopAll('SIGKILL'));

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/storage/database.js';
import { Repository } from '../src/storage/repository.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { createTeam } from '../src/agents/team.js';
import { DeveloperAgent } from '../src/agents/developer.js';
import { detectGit } from '../src/actions/git.js';

/** Creates a temporary directory removed after the test. */
export async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'scrum-workspace-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A fresh repository + orchestrator in a temporary data folder. */
export async function setup(t, { team = createTeam(), gitBinary } = {}) {
  const dataDir = await tempDir(t);
  const { db } = openDatabase(join(dataDir, 'workspace.db'));
  const repository = new Repository(db);
  const orchestrator = new Orchestrator({ repository, team, dataDir, gitBinary });
  orchestrator.init();
  t.after(async () => {
    if (orchestrator.current) await orchestrator.current.promise.catch(() => {});
    db.close();
  });
  return { dataDir, db, repository, orchestrator, team };
}

export const types = (events) => events.map((e) => e.type);

let gitStatus;
/** Whether git can be used on this machine (tests that need it are skipped otherwise). */
export async function gitAvailable() {
  gitStatus ??= detectGit();
  return (await gitStatus).available;
}

/**
 * TEST DOUBLE ONLY: a Developer that introduces a real defect in its first
 * `faultyAttempts` attempts (the page shows "Hello World" instead of
 * "Hello, World!"). Used to exercise the QA -> Developer correction loop.
 * Never used by the application.
 */
export class DefectiveDeveloper extends DeveloperAgent {
  constructor(faultyAttempts = 1) {
    super();
    this.faultyAttempts = faultyAttempts;
  }

  files(spec, attempt) {
    const files = super.files(spec, attempt);
    if (attempt > this.faultyAttempts) return files;
    return files.map((f) =>
      f.path === 'src/greet.js' ? { ...f, content: f.content.replace("'Hello, ' + (name || 'World') + '!'", "'Hello ' + (name || 'World')") } : f,
    );
  }
}

/** TEST DOUBLE ONLY: a Developer whose implementation waits until released. */
export class GatedDeveloper extends DeveloperAgent {
  constructor() {
    super();
    this.started = new Promise((resolve) => (this.markStarted = resolve));
    this.gate = new Promise((resolve) => (this.release = resolve));
  }

  async implement(input) {
    this.markStarted();
    await this.gate;
    return super.implement(input);
  }
}

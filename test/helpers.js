import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Creates a temporary directory removed after the test. */
export async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'scrum-workspace-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

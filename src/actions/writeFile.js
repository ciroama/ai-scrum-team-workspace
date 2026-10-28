import { mkdir, writeFile as fsWriteFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/**
 * Resolves `relPath` inside `rootDir`, refusing anything that escapes it.
 * @returns {string} absolute path
 */
export function resolveInside(rootDir, relPath) {
  const root = resolve(rootDir);
  const target = resolve(root, relPath);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to write outside the run workspace: ${relPath}`);
  }
  return target;
}

/**
 * Writes a file into a run workspace.
 * @returns {Promise<{ path: string, bytes: number, sha256: string }>}
 */
export async function writeFile(rootDir, relPath, content) {
  const target = resolveInside(rootDir, relPath);
  await mkdir(dirname(target), { recursive: true });
  await fsWriteFile(target, content, 'utf8');
  return {
    path: relPath,
    bytes: Buffer.byteLength(content, 'utf8'),
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

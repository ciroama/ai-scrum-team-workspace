import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../storage/database.js';
import { Repository } from '../storage/repository.js';
import { Orchestrator, ConflictError } from '../core/orchestrator.js';
import { RUN_MODES, SEED_STORIES, WORKFLOWS } from '../core/workflows.js';
import { createTeam } from '../agents/team.js';
import { AgentKind } from '../agents/agent.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
const STATIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/styles.css': 'styles.css',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const MAX_BODY_BYTES = 16 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
}

/** Lists files under `dir` (recursively) with their contents. */
async function readWorkspaceFiles(dir) {
  const files = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const { size } = await stat(full);
        files.push({ path: relative(dir, full), bytes: size, content: await readFile(full, 'utf8') });
      }
    }
  }
  await walk(dir);
  return files;
}

/**
 * Builds the application (storage, team, orchestrator, HTTP handler)
 * without listening. Useful for tests.
 */
export function createApp({ dataDir }) {
  const db = openDatabase(join(dataDir, 'workspace.db'));
  const repository = new Repository(db);
  const team = createTeam();
  const orchestrator = new Orchestrator({ repository, team, dataDir });

  repository.markInterruptedRuns();
  for (const story of SEED_STORIES) repository.ensureStory(story);

  const sseClients = new Set();
  const broadcast = (eventName, data) => {
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(frame);
  };
  repository.on('event', (event) => broadcast('execution', event));
  repository.on('change', (change) => broadcast('change', change));
  const heartbeat = setInterval(() => {
    for (const res of sseClients) res.write(': keep-alive\n\n');
  }, 15_000);
  heartbeat.unref();

  const routes = [
    [
      'GET',
      /^\/api\/state$/,
      () => ({
        workspace: { name: 'AI Scrum Team Workspace', milestone: 1 },
        agentKinds: AgentKind,
        team: [...team.values()].map((agent) => agent.profile),
        workflows: WORKFLOWS,
        runModes: RUN_MODES,
        stories: repository.listStories(),
        runs: repository.listRuns({ limit: 20 }),
      }),
    ],
    [
      'GET',
      /^\/api\/runs\/([\w-]+)$/,
      (_req, [runId]) => {
        const run = repository.getRun(runId);
        if (!run) throw new HttpError(404, 'Run not found');
        return { run, events: repository.listEvents(runId) };
      },
    ],
    [
      'GET',
      /^\/api\/runs\/([\w-]+)\/files$/,
      async (_req, [runId]) => {
        if (!repository.getRun(runId)) throw new HttpError(404, 'Run not found');
        return { files: await readWorkspaceFiles(orchestrator.workspaceDir(runId)) };
      },
    ],
    [
      'POST',
      /^\/api\/stories\/([\w-]+)\/runs$/,
      async (req, [storyId]) => {
        const { mode = 'standard' } = await readJsonBody(req);
        if (!repository.getStory(storyId)) throw new HttpError(404, 'Story not found');
        if (!(mode in RUN_MODES)) throw new HttpError(400, `Unknown run mode "${mode}"`);
        try {
          const { run } = orchestrator.startRun(storyId, { mode });
          return [202, { run }];
        } catch (error) {
          if (error instanceof ConflictError) throw new HttpError(409, error.message);
          throw error;
        }
      },
    ],
  ];

  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && pathname === '/api/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (req.method === 'GET' && STATIC_FILES[pathname]) {
        const file = STATIC_FILES[pathname];
        const body = await readFile(join(PUBLIC_DIR, file));
        res.writeHead(200, { 'Content-Type': MIME[extname(file)], 'Cache-Control': 'no-cache' });
        res.end(body);
        return;
      }

      for (const [method, pattern, handler] of routes) {
        const match = pathname.match(pattern);
        if (!match) continue;
        if (req.method !== method) continue;
        const result = await handler(req, match.slice(1));
        const [status, body] = Array.isArray(result) ? result : [200, result];
        sendJson(res, status, body);
        return;
      }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      const status = error.status ?? 500;
      if (status === 500) console.error(error);
      if (!res.headersSent) sendJson(res, status, { error: error.message });
      else res.end();
    }
  }

  function close() {
    clearInterval(heartbeat);
    for (const res of sseClients) res.end();
    sseClients.clear();
    db.close();
  }

  return { handle, repository, orchestrator, team, close };
}

/**
 * Starts the HTTP server. Binds to localhost only: the workspace runs
 * generated code and is meant for local use.
 */
export async function startServer({ port = 3000, host = '127.0.0.1', dataDir }) {
  const app = createApp({ dataDir });
  const server = createServer(app.handle);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    ...app,
    server,
    url: `http://${host === '127.0.0.1' ? 'localhost' : host}:${address.port}`,
    async close() {
      await Promise.allSettled([...app.orchestrator.active.values()]);
      app.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

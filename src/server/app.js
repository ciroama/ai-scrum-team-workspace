import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../storage/database.js';
import { Repository } from '../storage/repository.js';
import { ConflictError, NotFoundError, Orchestrator, REQUEST_LIMITS, ValidationError } from '../core/orchestrator.js';
import { describeTeam } from '../core/agentActivity.js';
import { STAGES, STAGE_ORDER, WORKFLOW_STATUS } from '../core/stages.js';
import { AI_WEB_RECIPE, catalogue, getRecipe } from '../recipes/index.js';
import { TeamRoster } from '../agents/roster.js';
import { AiSettings } from '../ai/aiSettings.js';
import { PreviewError, PreviewService } from '../preview/previewService.js';
import { computeAnalytics, parseDateFilter } from '../analytics/analytics.js';
import { AgentKind } from '../agents/agent.js';
import { resolveInside } from '../actions/writeFile.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
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
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'The request is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The request body must be JSON.');
  }
}

function statusFor(error) {
  if (error instanceof HttpError) return error.status;
  if (error instanceof ValidationError) return 400;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof ConflictError) return 409;
  return 500;
}

/**
 * Builds the application (storage, team, orchestrator, HTTP handler)
 * without listening. Useful for tests.
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {Map<string, object>} [options.team]
 * @param {string} [options.gitBinary]
 * @param {number} [options.previewPort]  0 (default) picks a free port
 * @param {string} [options.claudeBinary]  the `claude` command (overridable for tests)
 */
export function createApp({ dataDir, team, gitBinary, previewPort = 0, claudeBinary }) {
  const { db, legacyBackup } = openDatabase(join(dataDir, 'workspace.db'));
  const repository = new Repository(db);
  const aiSettings = new AiSettings({ repository, ...(claudeBinary ? { binary: claudeBinary } : {}) });
  team ??= new TeamRoster({ getMode: (agentId) => repository.getAgentMode(agentId), getClient: () => aiSettings.client() });
  const orchestrator = new Orchestrator({ repository, team, dataDir, gitBinary });
  orchestrator.init();

  /** Finds a workflow's product folder and the page the preview opens. */
  async function resolveProduct(workflowId) {
    const workflow = repository.getWorkflow(workflowId);
    if (!workflow) throw new PreviewError('This workflow does not exist.');
    const recipe = getRecipe(workflow.recipeId);
    if (!recipe) throw new PreviewError('This workflow has no product yet: the PO has not assigned a product type.');
    if (!recipe.preview || recipe.preview.type !== 'static') {
      throw new PreviewError(`Products of type "${recipe.title}" do not support Live Preview yet.`);
    }
    const dir = orchestrator.productDir(workflowId);
    if (!existsSync(join(dir, recipe.preview.entry))) {
      throw new PreviewError(`The product is not available: ${recipe.preview.entry} has not been generated for this workflow.`);
    }
    return { dir, entry: recipe.preview.entry, title: workflow.title };
  }
  const preview = new PreviewService({ resolveProduct, port: previewPort });

  const sseClients = new Set();
  const broadcast = (eventName, data) => {
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(frame);
  };
  repository.on('event', (event) => broadcast('workflow-event', event));
  repository.on('change', (change) => broadcast('change', change));
  preview.on('change', (status) => broadcast('preview', status));
  const heartbeat = setInterval(() => {
    for (const res of sseClients) res.write(': keep-alive\n\n');
  }, 15_000);
  heartbeat.unref();

  /** The workflow the dashboard focuses on: the active one, else the latest. */
  function focusWorkflow() {
    return repository.findActiveWorkflow() ?? repository.listWorkflows({ limit: 1 })[0] ?? null;
  }

  async function state() {
    const focus = focusWorkflow();
    const tasks = focus ? repository.listTasks(focus.id) : [];
    const events = focus ? repository.listTimeline(focus.id) : [];
    return {
      workspace: { name: 'AI Scrum Team Workspace', local: true, dataDir },
      agentKinds: AgentKind,
      agents: describeTeam({ team, config: repository.getAgentConfig(), workflow: focus, tasks, events }),
      recipes: catalogue(orchestrator.recipes),
      stages: STAGE_ORDER.map((id) => ({ id, title: STAGES[id].title, agent: STAGES[id].agent })),
      statusLabels: WORKFLOW_STATUS,
      requestLimits: REQUEST_LIMITS,
      workflows: repository.listWorkflows({ limit: 25 }).map(({ state: _state, ...summary }) => summary),
      focusWorkflowId: focus?.id ?? null,
      activeWorkflowId: repository.findActiveWorkflow()?.id ?? null,
      workspaceEvents: focus ? [] : repository.listWorkspaceEvents(),
      git: await orchestrator.git(),
      preview: preview.status(),
      ai: aiSettings.status(),
      legacyBackup,
    };
  }

  async function workflowDetail(id) {
    const workflow = repository.getWorkflow(id);
    if (!workflow) throw new HttpError(404, 'Workflow not found.');
    const { root, files } = await orchestrator.listProductFiles(id);
    return { workflow, tasks: repository.listTasks(id), events: repository.listTimeline(id), product: { root, files } };
  }

  const routes = [
    ['GET', /^\/api\/state$/, () => state()],
    ['GET', /^\/api\/workflows\/([\w-]+)$/, (_req, [id]) => workflowDetail(id)],
    [
      'POST',
      /^\/api\/workflows$/,
      async (req) => {
        const { request } = await readJsonBody(req);
        const { workflow } = orchestrator.submit(request);
        return [201, { workflow }];
      },
    ],
    [
      'GET',
      /^\/api\/analytics$/,
      (req) => {
        const params = new URL(req.url, 'http://localhost').searchParams;
        let from;
        let to;
        try {
          from = parseDateFilter(params.get('from'), 'from');
          to = parseDateFilter(params.get('to'), 'to');
        } catch (error) {
          throw new HttpError(400, error.message);
        }
        return computeAnalytics(
          repository.analyticsSource(),
          { projectId: params.get('project') || 'all', from, to },
          { recipes: catalogue([...orchestrator.recipes, AI_WEB_RECIPE]), agents: [...team.values()].map((a) => ({ id: a.id, label: a.label })) },
        );
      },
    ],
    ['GET', /^\/api\/ai$/, () => aiSettings.status()],
    [
      'PUT',
      /^\/api\/ai$/,
      async (req) => {
        const { model } = await readJsonBody(req);
        const result = aiSettings.update({ model });
        if (!result.ok) throw new HttpError(400, result.error);
        return aiSettings.status();
      },
    ],
    ['POST', /^\/api\/ai\/test$/, () => aiSettings.test()],
    ['GET', /^\/api\/preview$/, () => preview.status()],
    [
      'POST',
      /^\/api\/preview$/,
      async (req) => {
        const { workflowId } = await readJsonBody(req);
        if (typeof workflowId !== 'string' || !workflowId) throw new HttpError(400, 'Choose the workflow whose product you want to preview.');
        return preview.start(workflowId);
      },
    ],
    ['POST', /^\/api\/preview\/refresh$/, () => preview.refresh()],
    ['POST', /^\/api\/preview\/stop$/, () => preview.stop()],
    ['POST', /^\/api\/workflows\/([\w-]+)\/resume$/, (_req, [id]) => ({ workflow: orchestrator.resume(id).workflow })],
    ['POST', /^\/api\/workflows\/([\w-]+)\/cancel$/, (_req, [id]) => ({ workflow: orchestrator.cancel(id) })],
    [
      'PUT',
      /^\/api\/agents\/([\w-]+)$/,
      async (req, [agentId]) => {
        const body = await readJsonBody(req);
        if (body.enabled === undefined && body.mode === undefined) throw new HttpError(400, 'Send "enabled" and/or "mode".');
        let changed = false;
        if (body.mode !== undefined) changed = orchestrator.setAgentMode(agentId, body.mode, { modelName: aiSettings.model }).changed || changed;
        if (body.enabled !== undefined) changed = orchestrator.setAgentEnabled(agentId, body.enabled).changed || changed;
        return { changed };
      },
    ],
  ];

  async function serveStatic(pathname, res) {
    const relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    let file;
    try {
      file = resolveInside(PUBLIC_DIR, relativePath);
    } catch {
      return false;
    }
    const type = MIME[extname(file)];
    if (!type) return false;
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(body);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') return false;
      throw error;
    }
  }

  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && pathname === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (pathname.startsWith('/api/')) {
        for (const [method, pattern, handler] of routes) {
          const match = pathname.match(pattern);
          if (!match || req.method !== method) continue;
          const result = await handler(req, match.slice(1));
          const [status, body] = Array.isArray(result) ? result : [200, result];
          sendJson(res, status, body);
          return;
        }
        throw new HttpError(404, 'Not found.');
      }

      if (req.method === 'GET' && (await serveStatic(pathname, res))) return;
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      const status = statusFor(error);
      if (status === 500) console.error(error);
      const message = status === 500 ? `Internal error: ${error.message}` : error.message;
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
    }
  }

  async function close() {
    clearInterval(heartbeat);
    if (orchestrator.current) await orchestrator.current.promise.catch(() => {});
    await preview.close();
    for (const res of sseClients) res.end();
    sseClients.clear();
    db.close();
  }

  return { handle, repository, orchestrator, team, preview, aiSettings, close, legacyBackup };
}

/**
 * Starts the HTTP server. Binds to localhost only: the workspace runs
 * generated code and is meant for local use.
 */
export async function startServer({ port = 3000, host = '127.0.0.1', ...options }) {
  const app = createApp(options);
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
      await app.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

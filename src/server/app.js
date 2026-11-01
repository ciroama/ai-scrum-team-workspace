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
import { catalogue, getRecipe } from '../recipes/index.js';
import { TeamRoster } from '../agents/roster.js';
import { AiSettings } from '../ai/aiSettings.js';
import { PreviewError, PreviewService } from '../preview/previewService.js';
import { computeAnalytics, parseDateFilter } from '../analytics/analytics.js';
import { requestsCsv, statisticsCsv, tasksCsv } from '../analytics/export.js';
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

/** A route result sent as a file download instead of JSON. */
class FileResponse {
  constructor(name, type, body) {
    this.name = name;
    this.type = type;
    this.body = body;
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
  team ??= new TeamRoster({ getMode: (agentId) => repository.getAgentMode(agentId), getClient: (agentId) => aiSettings.client(repository.getAgentModel(agentId)) });
  const orchestrator = new Orchestrator({ repository, team, dataDir, gitBinary, modelOf: (agentId) => repository.getAgentModel(agentId) || aiSettings.model });
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
      workflows: repository.listWorkflows({ limit: 500 }).map(({ state: _state, ...summary }) => summary),
      products: repository.listProducts(),
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

  /** A product's requirement versions: one per iteration whose PO analysis was agreed. */
  function productDetail(productId) {
    const workflows = repository.listProductWorkflows(productId);
    if (!workflows.length) throw new HttpError(404, 'Product not found.');
    const product = repository.listProducts().find((p) => p.id === productId);
    return {
      product,
      iterations: workflows.map((w) => ({
        workflowId: w.id,
        requestText: w.requestText,
        change: Boolean(w.state?.base),
        baseVersion: w.state?.base?.version ?? null,
        status: w.status,
        verified: w.verified,
        createdAt: w.createdAt,
        finishedAt: w.finishedAt,
        spec: w.state?.spec
          ? {
              version: w.state.spec.version ?? null,
              title: w.state.spec.title,
              requirements: w.state.spec.requirements,
              acceptanceCriteria: w.state.spec.acceptanceCriteria.map(({ id, description }) => ({ id, description })),
              changes: w.state.spec.changes ?? null,
              assumptions: w.state.spec.assumptions ?? null,
              clarifications: w.state.spec.clarifications ?? null,
            }
          : null,
      })),
    };
  }

  async function deleteProduct(productId) {
    const doomed = new Set(productId == null ? repository.listWorkflows({ limit: 1e9 }).map((w) => w.id) : repository.listProductWorkflows(productId).map((w) => w.id));
    const previewed = preview.status().workflowId;
    const result = await orchestrator.deleteProduct(productId);
    if (previewed && doomed.has(previewed)) await preview.stop();
    return result;
  }

  const agentLabels = () => [...team.values()].map((a) => ({ id: a.id, label: a.label }));

  /** The Analytics filters of a request: ?project=all|<product id>&from=<iso>&to=<iso>. */
  function analyticsFilter(req) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    try {
      return { projectId: params.get('project') || 'all', from: parseDateFilter(params.get('from'), 'from'), to: parseDateFilter(params.get('to'), 'to') };
    } catch (error) {
      throw new HttpError(400, error.message);
    }
  }

  const routes = [
    ['GET', /^\/api\/state$/, () => state()],
    ['GET', /^\/api\/workflows\/([\w-]+)$/, (_req, [id]) => workflowDetail(id)],
    [
      'POST',
      /^\/api\/workflows$/,
      async (req) => {
        const { request, productId } = await readJsonBody(req);
        const { workflow } = orchestrator.submit(request, { productId: productId || null });
        return [201, { workflow }];
      },
    ],
    [
      'GET',
      /^\/api\/analytics$/,
      (req) => computeAnalytics(repository.analyticsSource(), analyticsFilter(req), { agents: agentLabels() }),
    ],
    [
      'GET',
      /^\/api\/analytics\/export\/(statistics|requests|tasks)\.csv$/,
      (req, [kind]) => {
        const filter = analyticsFilter(req);
        const source = repository.analyticsSource();
        const body = {
          statistics: () => statisticsCsv(source, filter, { agents: agentLabels() }),
          requests: () => requestsCsv(source, filter),
          tasks: () => tasksCsv(source, filter, { agents: agentLabels() }),
        }[kind]();
        const day = new Date().toISOString().slice(0, 10);
        return new FileResponse(`ai-scrum-${kind}-${day}.csv`, 'text/csv; charset=utf-8', body);
      },
    ],
    ['GET', /^\/api\/products$/, () => repository.listProducts()],
    ['GET', /^\/api\/products\/([\w-]+)$/, (_req, [id]) => productDetail(id)],
    ['DELETE', /^\/api\/products\/([\w-]+)$/, (_req, [id]) => deleteProduct(id)],
    [
      'DELETE',
      /^\/api\/products$/,
      (req) => {
        // Deleting everything must be asked for explicitly.
        if (new URL(req.url, 'http://localhost').searchParams.get('confirm') !== 'all') throw new HttpError(400, 'Add ?confirm=all to delete every product.');
        return deleteProduct(null);
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
    [
      'POST',
      /^\/api\/workflows\/([\w-]+)\/answer$/,
      async (req, [id]) => {
        const { answer } = await readJsonBody(req);
        return { workflow: orchestrator.answer(id, answer).workflow };
      },
    ],
    ['POST', /^\/api\/workflows\/([\w-]+)\/cancel$/, (_req, [id]) => ({ workflow: orchestrator.cancel(id) })],
    [
      'PUT',
      /^\/api\/agents\/([\w-]+)$/,
      async (req, [agentId]) => {
        const body = await readJsonBody(req);
        if (body.enabled === undefined && body.mode === undefined && body.model === undefined) throw new HttpError(400, 'Send "enabled", "mode" and/or "model".');
        let changed = false;
        if (body.model !== undefined) {
          if (body.model !== '' && body.model !== null && !AiSettings.isModelName(body.model)) throw new HttpError(400, 'The model must be a Claude Code model name, e.g. sonnet, opus or haiku.');
          changed = orchestrator.setAgentModel(agentId, body.model || null, { defaultModel: aiSettings.model }).changed || changed;
        }
        if (body.mode !== undefined) changed = orchestrator.setAgentMode(agentId, body.mode, { modelName: repository.getAgentModel(agentId) || aiSettings.model }).changed || changed;
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
          if (result instanceof FileResponse) {
            res.writeHead(200, {
              'Content-Type': result.type,
              'Content-Disposition': `attachment; filename="${result.name}"`,
              'Cache-Control': 'no-store',
            });
            res.end(result.body);
            return;
          }
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

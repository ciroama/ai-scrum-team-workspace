import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();
const parseJson = (text) => (text == null ? null : JSON.parse(text));
const stamp = () => now().replace(/[-:.TZ]/g, '').slice(0, 14);

function toWorkflow(row) {
  return row && {
    id: row.id,
    productId: row.product_id,
    requestText: row.request_text,
    recipeId: row.recipe_id,
    title: row.title,
    status: row.status,
    stage: row.stage,
    verified: row.verified === 1,
    blockedReason: row.blocked_reason,
    error: row.error,
    state: parseJson(row.state),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function toTask(row) {
  return row && {
    id: row.id,
    workflowId: row.workflow_id,
    agentId: row.agent_id,
    stage: row.stage,
    title: row.title,
    status: row.status,
    input: parseJson(row.input),
    output: parseJson(row.output),
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function toEvent(row) {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    ts: row.ts,
    type: row.type,
    category: row.category,
    actor: row.actor,
    actorKind: row.actor_kind,
    from: row.from_actor,
    to: row.to_actor,
    summary: row.summary,
    detail: parseJson(row.detail),
    status: row.status,
    error: row.error,
    taskId: row.task_id,
  };
}

const WORKFLOW_COLUMNS = {
  recipeId: 'recipe_id',
  title: 'title',
  status: 'status',
  stage: 'stage',
  verified: 'verified',
  blockedReason: 'blocked_reason',
  error: 'error',
  state: 'state',
  finishedAt: 'finished_at',
};

/** Workflow statuses that occupy the single workflow slot. */
export const ACTIVE_STATUSES = ['running', 'blocked'];

/**
 * Persistence for agent configuration, workflows, tasks and events.
 *
 * Emits:
 *  - 'event'  (event)            every time an event is stored
 *  - 'change' ({ entity, id })   when a workflow, task or agent setting changes
 */
export class Repository extends EventEmitter {
  /** @param {import('node:sqlite').DatabaseSync} db */
  constructor(db) {
    super();
    this.db = db;
  }

  // ---- agent configuration -------------------------------------------------

  /** Creates configuration rows (enabled) for agents that have none yet. */
  ensureAgents(agentIds) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO agent_config (agent_id, enabled, updated_at) VALUES (?, 1, ?)');
    for (const id of agentIds) insert.run(id, now());
  }

  /** @returns {Record<string, { enabled: boolean, mode: 'scripted' | 'ai', updatedAt: string }>} */
  getAgentConfig() {
    const config = {};
    for (const row of this.db.prepare('SELECT * FROM agent_config').all()) {
      config[row.agent_id] = { enabled: row.enabled === 1, mode: row.mode, updatedAt: row.updated_at };
    }
    return config;
  }

  getAgentMode(agentId) {
    return this.db.prepare('SELECT mode FROM agent_config WHERE agent_id = ?').get(agentId)?.mode ?? 'scripted';
  }

  setAgentMode(agentId, mode) {
    this.db.prepare('UPDATE agent_config SET mode = ?, updated_at = ? WHERE agent_id = ?').run(mode, now(), agentId);
    this.emit('change', { entity: 'agent', id: agentId });
  }

  // ---- settings (local only; data/ is not in Git) ----------------------------

  getSetting(key) {
    return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
  }

  setSetting(key, value) {
    if (value == null || value === '') {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    } else {
      this.db
        .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .run(key, value, now());
    }
    this.emit('change', { entity: 'settings', id: key });
  }

  isAgentEnabled(agentId) {
    const row = this.db.prepare('SELECT enabled FROM agent_config WHERE agent_id = ?').get(agentId);
    return row?.enabled === 1;
  }

  setAgentEnabled(agentId, enabled) {
    this.db
      .prepare('UPDATE agent_config SET enabled = ?, updated_at = ? WHERE agent_id = ?')
      .run(enabled ? 1 : 0, now(), agentId);
    this.emit('change', { entity: 'agent', id: agentId });
  }

  // ---- workflows -----------------------------------------------------------

  /**
   * @param {{ requestText: string, stage: string, productId?: string | null, title?: string, state?: object }} fields
   *   productId: the product this request changes; omitted for a new product
   */
  createWorkflow({ requestText, stage, productId = null, title = 'New request', state = {} }) {
    const id = `wf-${stamp()}-${randomUUID().slice(0, 6)}`;
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO workflows (id, product_id, request_text, title, status, stage, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(id, productId ?? id, requestText, title, stage, JSON.stringify(state), ts, ts);
    this.emit('change', { entity: 'workflow', id });
    return this.getWorkflow(id);
  }

  getWorkflow(id) {
    return toWorkflow(this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id));
  }

  listWorkflows({ limit = 20 } = {}) {
    return this.db
      .prepare('SELECT * FROM workflows ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(limit)
      .map(toWorkflow);
  }

  /** The workflows (iterations) of a product, oldest first. */
  listProductWorkflows(productId) {
    return this.db
      .prepare('SELECT * FROM workflows WHERE product_id = ? ORDER BY created_at, rowid')
      .all(productId)
      .map(toWorkflow);
  }

  /**
   * Every product with a summary of its iterations, most recently changed
   * first. The title is the one from the latest agreed requirements.
   */
  listProducts() {
    const byProduct = new Map();
    for (const workflow of this.db.prepare('SELECT * FROM workflows ORDER BY created_at, rowid').all().map(toWorkflow)) {
      const list = byProduct.get(workflow.productId) ?? [];
      list.push(workflow);
      byProduct.set(workflow.productId, list);
    }
    return [...byProduct.entries()]
      .map(([id, workflows]) => {
        const latest = workflows.at(-1);
        const withSpec = workflows.filter((w) => w.state?.spec);
        return {
          id,
          title: withSpec.at(-1)?.state.spec.title ?? latest.title,
          iterations: workflows.length,
          versions: withSpec.length,
          latestWorkflowId: latest.id,
          latestStatus: latest.status,
          recipeId: withSpec.at(-1)?.recipeId ?? null,
          createdAt: workflows[0].createdAt,
          updatedAt: latest.updatedAt,
        };
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /**
   * Deletes workflows with their tasks and events, for good.
   * @param {string | null} productId  null deletes everything, including
   *   workspace-level events
   * @returns {string[]} the deleted workflow ids
   */
  deleteWorkflows(productId) {
    const ids = (productId == null
      ? this.db.prepare('SELECT id FROM workflows').all()
      : this.db.prepare('SELECT id FROM workflows WHERE product_id = ?').all(productId)
    ).map((r) => r.id);
    this.db.exec('BEGIN');
    try {
      if (productId == null) {
        this.db.exec('DELETE FROM events; DELETE FROM tasks; DELETE FROM workflows;');
      } else {
        for (const id of ids) {
          this.db.prepare('DELETE FROM events WHERE workflow_id = ?').run(id);
          this.db.prepare('DELETE FROM tasks WHERE workflow_id = ?').run(id);
          this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.emit('change', { entity: 'product', id: productId });
    return ids;
  }

  /** The workflow occupying the single slot (running or blocked), if any. */
  findActiveWorkflow() {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
    return toWorkflow(
      this.db
        .prepare(`SELECT * FROM workflows WHERE status IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`)
        .get(...ACTIVE_STATUSES),
    );
  }

  updateWorkflow(id, fields) {
    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(fields)) {
      const column = WORKFLOW_COLUMNS[key];
      if (!column) throw new Error(`Unknown workflow field ${key}`);
      sets.push(`${column} = ?`);
      if (key === 'state') values.push(JSON.stringify(value));
      else if (key === 'verified') values.push(value ? 1 : 0);
      else values.push(value ?? null);
    }
    sets.push('updated_at = ?');
    values.push(now(), id);
    this.db.prepare(`UPDATE workflows SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    this.emit('change', { entity: 'workflow', id });
    return this.getWorkflow(id);
  }

  // ---- tasks ---------------------------------------------------------------

  startTask({ workflowId, agentId, stage, title, input }) {
    const id = `task-${stamp()}-${randomUUID().slice(0, 6)}`;
    this.db
      .prepare(
        `INSERT INTO tasks (id, workflow_id, agent_id, stage, title, status, input, started_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(id, workflowId, agentId, stage, title, JSON.stringify(input ?? null), now());
    this.emit('change', { entity: 'task', id });
    return this.getTask(id);
  }

  finishTask(id, { status, output = null, error = null }) {
    this.db
      .prepare('UPDATE tasks SET status = ?, output = ?, error = ?, finished_at = ? WHERE id = ?')
      .run(status, JSON.stringify(output), error, now(), id);
    this.emit('change', { entity: 'task', id });
    return this.getTask(id);
  }

  getTask(id) {
    return toTask(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  }

  listTasks(workflowId) {
    return this.db
      .prepare('SELECT * FROM tasks WHERE workflow_id = ? ORDER BY started_at, rowid')
      .all(workflowId)
      .map(toTask);
  }

  listRunningTasks() {
    return this.db.prepare(`SELECT * FROM tasks WHERE status = 'running'`).all().map(toTask);
  }

  // ---- events --------------------------------------------------------------

  /**
   * Appends an event. `workflowId` may be null for workspace-level events
   * such as agent configuration changes made while no workflow is active.
   */
  appendEvent({
    workflowId = null,
    type,
    category,
    actor = 'system',
    actorKind = 'system',
    from = null,
    to = null,
    summary,
    detail = null,
    status = 'info',
    error = null,
    taskId = null,
  }) {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO events (workflow_id, ts, type, category, actor, actor_kind, from_actor, to_actor,
                             summary, detail, status, error, task_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(workflowId, now(), type, category, actor, actorKind, from, to, summary,
        detail == null ? null : JSON.stringify(detail), status, error, taskId);
    const event = toEvent(this.db.prepare('SELECT * FROM events WHERE id = ?').get(lastInsertRowid));
    this.emit('event', event);
    return event;
  }

  listEvents(workflowId) {
    return this.db.prepare('SELECT * FROM events WHERE workflow_id = ? ORDER BY id').all(workflowId).map(toEvent);
  }

  /**
   * The activity timeline of a workflow: its own events plus workspace-level
   * events (e.g. agent configuration changes) recorded between its creation
   * and the creation of the next workflow.
   */
  listTimeline(workflowId) {
    const workflow = this.getWorkflow(workflowId);
    if (!workflow) return [];
    const next = this.db
      .prepare('SELECT created_at FROM workflows WHERE created_at > ? ORDER BY created_at LIMIT 1')
      .get(workflow.createdAt);
    return this.db
      .prepare(
        `SELECT * FROM events
         WHERE workflow_id = ?
            OR (workflow_id IS NULL AND ts >= ? AND (? IS NULL OR ts < ?))
         ORDER BY id`,
      )
      .all(workflowId, workflow.createdAt, next?.created_at ?? null, next?.created_at ?? null)
      .map(toEvent);
  }

  /** Recent workspace-level events (no workflow attached). */
  listWorkspaceEvents({ limit = 20 } = {}) {
    return this.db
      .prepare('SELECT * FROM events WHERE workflow_id IS NULL ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map(toEvent)
      .reverse();
  }

  // ---- analytics source data -------------------------------------------------

  /**
   * Every workflow, task and the analytics-relevant events, read as recorded.
   * Workspace-level events (no workflow) are excluded: they belong to no
   * project.
   */
  analyticsSource() {
    const workflows = this.db.prepare('SELECT * FROM workflows ORDER BY created_at, rowid').all().map(toWorkflow);
    const tasks = this.db.prepare('SELECT * FROM tasks ORDER BY started_at, rowid').all().map(toTask);
    const events = this.db
      .prepare(
        `SELECT * FROM events
         WHERE workflow_id IS NOT NULL
           AND type IN ('test.results', 'handoff', 'workflow.blocked', 'workflow.resumed', 'workflow.cancelled', 'ai.call')
         ORDER BY id`,
      )
      .all()
      .map(toEvent);
    return { workflows, tasks, events };
  }

  // ---- startup recovery ----------------------------------------------------

  /**
   * Tasks and workflows still marked 'running' when the process starts were
   * cut off by a shutdown. Mark them so history stays truthful.
   * @returns {object[]} the workflows that were interrupted
   */
  markInterrupted() {
    for (const task of this.listRunningTasks()) {
      this.finishTask(task.id, { status: 'interrupted', error: 'The application stopped while this task was running' });
    }
    const rows = this.db.prepare(`SELECT id FROM workflows WHERE status = 'running'`).all();
    return rows.map(({ id }) => this.updateWorkflow(id, { status: 'interrupted' }));
  }
}

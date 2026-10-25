import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();

const parseJson = (text) => (text == null ? null : JSON.parse(text));

function toStory(row) {
  return row && {
    id: row.id,
    title: row.title,
    description: row.description,
    workflow: row.workflow,
    status: row.status,
    acceptance: parseJson(row.acceptance),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(row) {
  return row && {
    id: row.id,
    storyId: row.story_id,
    mode: row.mode,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    summary: parseJson(row.summary),
  };
}

function toEvent(row) {
  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    step: row.step,
    agentId: row.agent_id,
    agentKind: row.agent_kind,
    payload: JSON.parse(row.payload),
  };
}

/**
 * Persistence for stories, runs and execution events.
 *
 * Emits:
 *  - 'event'  (event)  every time an execution event is stored
 *  - 'change' ({ entity, id }) when a story or run changes
 */
export class Repository extends EventEmitter {
  /** @param {import('node:sqlite').DatabaseSync} db */
  constructor(db) {
    super();
    this.db = db;
  }

  // ---- stories -----------------------------------------------------------

  /** Inserts a story if no story with that id exists yet. */
  ensureStory({ id, title, description, workflow }) {
    const ts = now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO stories (id, title, description, workflow, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'todo', ?, ?)`,
      )
      .run(id, title, description, workflow, ts, ts);
    return this.getStory(id);
  }

  listStories() {
    return this.db.prepare('SELECT * FROM stories ORDER BY created_at').all().map(toStory);
  }

  getStory(id) {
    return toStory(this.db.prepare('SELECT * FROM stories WHERE id = ?').get(id));
  }

  updateStory(id, { status, acceptance }) {
    const story = this.getStory(id);
    if (!story) throw new Error(`Unknown story ${id}`);
    this.db
      .prepare('UPDATE stories SET status = ?, acceptance = ?, updated_at = ? WHERE id = ?')
      .run(
        status ?? story.status,
        JSON.stringify(acceptance ?? story.acceptance),
        now(),
        id,
      );
    this.emit('change', { entity: 'story', id });
    return this.getStory(id);
  }

  // ---- runs --------------------------------------------------------------

  createRun({ storyId, mode }) {
    const id = `run-${now().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 6)}`;
    this.db
      .prepare(`INSERT INTO runs (id, story_id, mode, status, started_at) VALUES (?, ?, ?, 'running', ?)`)
      .run(id, storyId, mode, now());
    this.emit('change', { entity: 'run', id });
    return this.getRun(id);
  }

  finishRun(id, { status, summary }) {
    this.db
      .prepare('UPDATE runs SET status = ?, summary = ?, finished_at = ? WHERE id = ?')
      .run(status, JSON.stringify(summary), now(), id);
    this.emit('change', { entity: 'run', id });
    return this.getRun(id);
  }

  getRun(id) {
    return toRun(this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id));
  }

  listRuns({ limit = 20 } = {}) {
    return this.db
      .prepare('SELECT * FROM runs ORDER BY started_at DESC, rowid DESC LIMIT ?')
      .all(limit)
      .map(toRun);
  }

  /**
   * Runs still marked 'running' when the process starts were cut off by a
   * shutdown. Mark them so the history stays truthful.
   */
  markInterruptedRuns() {
    const stale = this.db.prepare(`SELECT id FROM runs WHERE status = 'running'`).all();
    for (const { id } of stale) {
      this.finishRun(id, { status: 'interrupted', summary: { reason: 'Server stopped during the run' } });
    }
    return stale.length;
  }

  // ---- events ------------------------------------------------------------

  /**
   * Appends an execution event to a run. Sequence numbers are per run and
   * strictly increasing.
   */
  appendEvent(runId, { type, step = null, agentId = null, agentKind = null, payload = {} }) {
    const { next } = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE run_id = ?')
      .get(runId);
    const ts = now();
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO events (run_id, seq, ts, type, step, agent_id, agent_kind, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, next, ts, type, step, agentId, agentKind, JSON.stringify(payload));
    const event = toEvent(this.db.prepare('SELECT * FROM events WHERE id = ?').get(lastInsertRowid));
    this.emit('event', event);
    return event;
  }

  listEvents(runId) {
    return this.db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY seq').all(runId).map(toEvent);
  }
}

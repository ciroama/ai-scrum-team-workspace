// CSV exports of the Analytics page, for analysis in a spreadsheet. They
// use the same records and the same filters as the page: the statistics as
// shown, one row per request, and one row per agent task.

import { computeAnalytics, selectWorkflows } from './analytics.js';

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (starting
 * with = + - @) is prefixed with an apostrophe; numbers are written as is.
 */
function cell(value) {
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** @param {Array<[string, (row: any) => unknown]>} columns */
function toCsv(rows, columns) {
  const lines = [columns.map(([name]) => cell(name)).join(',')];
  for (const row of rows) lines.push(columns.map(([, get]) => cell(get(row))).join(','));
  // The byte order mark makes Excel read the file as UTF-8.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

const durationMs = (from, to) => (from && to ? new Date(to) - new Date(from) : null);

/** The statistics shown on the page: KPIs, outcomes and agent activity. */
export function statisticsCsv(source, filter, catalogue) {
  const data = computeAnalytics(source, filter, catalogue);
  const rows = [
    ...data.kpis.map((k) => ({ section: 'KPI', metric: k.label, value: k.value, unit: k.unit, detail: k.detail, source: k.source, basis: k.basis })),
    ...data.outcomes.map((o) => ({ section: 'Workflow outcome', metric: o.label, value: o.value, unit: 'count', source: 'recorded', basis: 'Current status of each selected workflow.' })),
    ...data.agents.flatMap((a) => [
      { section: `Agent: ${a.label}`, metric: 'Tasks completed', value: a.tasksCompleted, unit: 'count', source: 'recorded' },
      { section: `Agent: ${a.label}`, metric: 'Tasks failed', value: a.tasksFailed, unit: 'count', source: 'recorded' },
      { section: `Agent: ${a.label}`, metric: 'Tasks interrupted', value: a.tasksInterrupted, unit: 'count', source: 'recorded' },
      { section: `Agent: ${a.label}`, metric: 'Handoffs sent', value: a.handoffsSent, unit: 'count', source: 'recorded' },
      { section: `Agent: ${a.label}`, metric: 'Blocks caused while disabled', value: a.blocksCaused, unit: 'count', source: 'recorded' },
      { section: `Agent: ${a.label}`, metric: 'Execution time', value: a.executionMs, unit: 'ms', source: 'calculated', basis: 'Sum of finished task durations.' },
      { section: `Agent: ${a.label}`, metric: 'Average task time', value: a.averageTaskMs == null ? null : Math.round(a.averageTaskMs), unit: 'ms', source: 'calculated', basis: 'Mean of finished task durations.' },
    ]),
  ];
  // Rates are fractions (0–1) and durations milliseconds, so spreadsheets can compute with them.
  const unit = { percent: 'fraction 0-1', duration: 'ms' };
  return toCsv(rows, [
    ['section', (r) => r.section],
    ['metric', (r) => r.metric],
    ['value', (r) => r.value],
    ['unit', (r) => unit[r.unit] ?? r.unit],
    ['detail', (r) => r.detail],
    ['source', (r) => r.source],
    ['how it is computed', (r) => r.basis],
  ]);
}

/** One row per request (workflow), with what the records say about it. */
export function requestsCsv(source, filter) {
  const titles = new Map(computeAnalytics(source, {}, {}).projects.map((p) => [p.id, p.title]));
  const workflows = selectWorkflows(source, filter);
  const eventsOf = (id, type) => source.events.filter((e) => e.workflowId === id && e.type === type);
  const rows = workflows.map((w) => {
    const testRuns = eventsOf(w.id, 'test.results');
    const lastRun = testRuns.at(-1)?.detail?.summary;
    const aiCalls = eventsOf(w.id, 'ai.call');
    const blocks = eventsOf(w.id, 'workflow.blocked');
    const spec = w.state?.spec;
    return {
      w,
      product: titles.get(w.productId ?? w.id),
      spec,
      testRuns,
      lastRun,
      aiCalls,
      blocks,
      corrections: eventsOf(w.id, 'handoff').filter((e) => e.from === 'qa' && e.to === 'dev').length,
      poRework: eventsOf(w.id, 'handoff').filter((e) => e.from === 'po' && e.to === 'dev' && e.status === 'failure').length,
    };
  });
  return toCsv(rows, [
    ['request id', (r) => r.w.id],
    ['product id', (r) => r.w.productId ?? r.w.id],
    ['product', (r) => r.product],
    ['kind', (r) => (r.w.state?.base ? 'change request' : 'new product')],
    ['request', (r) => r.w.requestText],
    ['submitted at', (r) => r.w.createdAt],
    ['finished at', (r) => r.w.finishedAt],
    ['duration ms', (r) => durationMs(r.w.createdAt, r.w.finishedAt)],
    ['status', (r) => r.w.status],
    ['verified by QA', (r) => r.w.verified],
    ['PO interruptions', (r) => eventsOf(r.w.id, 'po.clarification').length],
    ['PO questions', (r) => eventsOf(r.w.id, 'po.clarification').reduce((n, e) => n + (e.detail?.questions?.length || 1), 0)],
    ['your answers', (r) => eventsOf(r.w.id, 'clarification.answered').length],
    ['requirements version', (r) => r.spec?.version ?? null],
    ['requirements', (r) => r.spec?.requirements.length ?? null],
    ['acceptance criteria', (r) => r.spec?.acceptanceCriteria.length ?? null],
    ['implementation attempts', (r) => r.w.state?.attempt ?? 0],
    ['corrections from QA', (r) => r.corrections],
    ['rework from the PO', (r) => r.poRework],
    ['test runs', (r) => r.testRuns.length],
    ['tests in last run', (r) => r.lastRun?.tests ?? null],
    ['tests passed in last run', (r) => r.lastRun?.pass ?? null],
    ['tests failed in last run', (r) => r.lastRun?.fail ?? null],
    ['blocks', (r) => r.blocks.length],
    ['AI requests', (r) => r.aiCalls.length],
    ['AI requests failed', (r) => r.aiCalls.filter((e) => e.status !== 'success').length],
    ['AI input tokens', (r) => r.aiCalls.reduce((n, e) => n + (e.detail?.usage?.promptTokens ?? 0), 0)],
    ['AI output tokens', (r) => r.aiCalls.reduce((n, e) => n + (e.detail?.usage?.completionTokens ?? 0), 0)],
    ['AI models', (r) => [...new Set(r.aiCalls.map((e) => e.detail?.model).filter(Boolean))].join(' ')],
  ]);
}

/** One row per agent task, as recorded. */
export function tasksCsv(source, filter, { agents = [] } = {}) {
  const workflows = new Map(selectWorkflows(source, filter).map((w) => [w.id, w]));
  const label = (id) => agents.find((a) => a.id === id)?.label ?? id;
  const rows = source.tasks.filter((t) => workflows.has(t.workflowId));
  return toCsv(rows, [
    ['task id', (t) => t.id],
    ['request id', (t) => t.workflowId],
    ['product id', (t) => workflows.get(t.workflowId).productId ?? t.workflowId],
    ['agent', (t) => label(t.agentId)],
    ['stage', (t) => t.stage],
    ['task', (t) => t.title],
    ['status', (t) => t.status],
    ['started at', (t) => t.startedAt],
    ['finished at', (t) => t.finishedAt],
    ['duration ms', (t) => durationMs(t.startedAt, t.finishedAt)],
    ['error', (t) => t.error],
  ]);
}

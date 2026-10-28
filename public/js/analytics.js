// Analytics page. Everything shown comes from GET /api/analytics, which
// calculates it from persisted workflows, tasks and events. Missing data is
// shown as "Not enough data yet", never as invented values.

import { duration, h, icon, mount } from './dom.js';

const NOT_ENOUGH = 'Not enough data yet';
// Validated against the dark chart surface (see docs/architecture.md).
const SERIES_COLOR = '#0ea5c4';
const TONE_COLOR = { good: '#0b9a6a', warning: '#b98509', critical: '#dc4a4f', neutral: '#6b7891' };

function formatValue(kpi) {
  if (kpi.value == null) return null;
  if (kpi.unit === 'percent') return `${Math.round(kpi.value * 100)}%`;
  if (kpi.unit === 'duration') return duration(kpi.value);
  return String(kpi.value);
}

function sourceBadge(source) {
  return source === 'recorded'
    ? h('span', { className: 'badge badge-recorded', title: 'Read directly from recorded workflows, tasks or events' }, 'Recorded')
    : h('span', { className: 'badge badge-calculated', title: 'Calculated from recorded data' }, 'Calculated');
}

/** Local calendar date (YYYY-MM-DD) → ISO timestamp at local midnight. */
function localDayToIso(day, addDays = 0) {
  if (!day) return '';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d + addDays).toISOString();
}

function filterParams(filter) {
  const params = new URLSearchParams();
  params.set('project', filter.projectId || 'all');
  if (filter.from) params.set('from', localDayToIso(filter.from));
  if (filter.to) params.set('to', localDayToIso(filter.to, 1)); // the end date is inclusive
  return params;
}

export function analyticsQuery(filter) {
  return `/api/analytics?${filterParams(filter)}`;
}

const EXPORTS = [
  ['statistics', 'Statistics', 'The numbers on this page: KPIs, outcomes and agent activity'],
  ['requests', 'Requests', 'One row per request: status, verification, clarifications, corrections, tests, AI requests and tokens'],
  ['tasks', 'Tasks', 'One row per agent task: agent, stage, status and duration'],
];

// ---- tooltip (one shared element) -------------------------------------------------------

let tooltip = null;
function attachTooltip(el, text) {
  el.setAttribute('aria-label', text);
  el.addEventListener('mouseenter', () => {
    tooltip = tooltip || document.body.appendChild(h('div', { className: 'chart-tooltip', role: 'tooltip' }));
    tooltip.textContent = text;
    tooltip.hidden = false;
  });
  el.addEventListener('mousemove', (e) => {
    if (!tooltip) return;
    tooltip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8)}px`;
    tooltip.style.top = `${e.clientY + 14}px`;
  });
  el.addEventListener('mouseleave', () => {
    if (tooltip) tooltip.hidden = true;
  });
  return el;
}

// ---- page shell ----------------------------------------------------------------------------

export function mountAnalytics(ui, actions) {
  const onChange = () => {
    actions.setAnalyticsFilter({
      projectId: document.getElementById('an-project').value,
      from: document.getElementById('an-from').value,
      to: document.getElementById('an-to').value,
    });
  };
  mount(
    'view',
    h(
      'section',
      { className: 'panel' },
      h(
        'div',
        { className: 'view-head' },
        h('div', null, h('h1', null, 'Analytics'), h('p', { className: 'muted' }, 'Statistics calculated from the workflows, tasks and events recorded in this workspace.')),
        h(
          'div',
          { className: 'export-actions', role: 'group', 'aria-label': 'Export as CSV, with the current filters' },
          h('span', { className: 'muted small' }, 'Export CSV:'),
          EXPORTS.map(([kind, label, title]) => h('a', { id: `an-export-${kind}`, className: 'btn btn-sm', href: '#', download: '', title }, label)),
        ),
      ),
      h(
        'div',
        { className: 'filter-bar', role: 'group', 'aria-label': 'Filters' },
        h('label', null, h('span', null, 'Project'), h('select', { id: 'an-project', onchange: onChange }, h('option', { value: 'all' }, 'All Projects'))),
        h('label', null, h('span', null, 'Submitted from'), h('input', { id: 'an-from', type: 'date', value: ui.analyticsFilter.from, onchange: onChange })),
        h('label', null, h('span', null, 'to'), h('input', { id: 'an-to', type: 'date', value: ui.analyticsFilter.to, onchange: onChange })),
        h('button', { type: 'button', className: 'btn btn-sm btn-ghost', onclick: () => actions.setAnalyticsFilter({ projectId: 'all', from: '', to: '' }, true) }, 'Reset'),
      ),
      h('div', { id: 'an-body' }),
    ),
  );
}

// ---- rendering -----------------------------------------------------------------------------

export function renderAnalytics(data, ui) {
  const body = document.getElementById('an-body');
  if (!body) return;
  // Exports follow the filters currently applied.
  for (const [kind] of EXPORTS) document.getElementById(`an-export-${kind}`).href = `/api/analytics/export/${kind}.csv?${filterParams(ui.analyticsFilter)}`;
  if (ui.analyticsError) {
    mount(body, h('div', { className: 'feedback', dataset: { tone: 'error' } }, `Analytics could not be loaded: ${ui.analyticsError}`));
    return;
  }
  if (!data) {
    mount(body, h('p', { className: 'muted' }, 'Loading…'));
    return;
  }

  // Project selector: All Projects + projects present in the system.
  const select = document.getElementById('an-project');
  const wanted = ui.analyticsFilter.projectId || 'all';
  mount(
    select,
    h('option', { value: 'all' }, 'All Projects'),
    data.projects.map((p) => h('option', { value: p.id }, `${p.title} (${p.workflows})`)),
  );
  select.value = data.projects.some((p) => p.id === wanted) ? wanted : 'all';

  mount(
    body,
    data.empty
      ? h('div', { className: 'empty' }, `${NOT_ENOUGH}: no workflows match the selected filters. Statistics appear once workflows have been run.`)
      : null,
    h('div', { className: 'kpi-grid' }, data.kpis.map(kpiCard)),
    h(
      'div',
      { className: 'chart-grid' },
      chartPanel('Workflow outcomes', 'recorded', 'Current status of each selected workflow.', outcomesChart(data)),
      chartPanel('Agent activity', 'recorded', 'Tasks completed by each agent, from the tasks table.', agentChart(data)),
      chartPanel('Workflows submitted per day', 'recorded', 'Grouped by the local date each workflow was submitted.', dailyChart(data)),
    ),
    agentTable(data),
    transparency(data),
  );
}

function kpiCard(kpi) {
  const text = formatValue(kpi);
  return h(
    'article',
    { className: 'kpi', title: kpi.basis },
    h('div', { className: 'kpi-head' }, h('span', { className: 'kpi-label' }, kpi.label), sourceBadge(kpi.source)),
    text == null ? h('div', { className: 'kpi-value kpi-empty' }, NOT_ENOUGH) : h('div', { className: 'kpi-value' }, text),
    kpi.detail && text != null ? h('div', { className: 'kpi-detail' }, kpi.detail) : null,
  );
}

function chartPanel(title, source, subtitle, content) {
  return h(
    'section',
    { className: 'chart-panel' },
    h('div', { className: 'kpi-head' }, h('h2', null, title), sourceBadge(source)),
    h('p', { className: 'muted small' }, subtitle),
    content,
  );
}

/** Horizontal bars with a direct label and value on every row. */
function barList(rows, ariaLabel) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return h(
    'div',
    { className: 'bar-list', role: 'list', 'aria-label': ariaLabel },
    rows.map((row) =>
      attachTooltip(
        h(
          'div',
          { className: 'bar-row', role: 'listitem' },
          h('span', { className: 'bar-label' }, row.label),
          h('span', { className: 'bar-track' }, h('span', { className: 'bar-fill', style: `width:${(row.value / max) * 100}%;background:${row.color}` })),
          h('span', { className: 'bar-value' }, row.valueText ?? String(row.value)),
        ),
        row.tip,
      ),
    ),
  );
}

function outcomesChart(data) {
  if (data.empty) return h('p', { className: 'kpi-empty' }, NOT_ENOUGH);
  const rows = data.outcomes.filter((o) => o.value > 0);
  return [
    barList(
      rows.map((o) => ({ label: o.label, value: o.value, color: TONE_COLOR[o.tone], tip: `${o.label}: ${o.value} workflow${o.value === 1 ? '' : 's'}` })),
      'Workflow outcomes',
    ),
    rows.length < data.outcomes.length ? h('p', { className: 'muted small' }, 'Statuses with no workflows are not shown.') : null,
  ];
}

function agentChart(data) {
  if (data.empty || data.agents.every((a) => a.tasksCompleted + a.tasksFailed === 0)) return h('p', { className: 'kpi-empty' }, NOT_ENOUGH);
  return barList(
    data.agents.map((a) => ({
      label: a.label,
      value: a.tasksCompleted,
      color: SERIES_COLOR,
      tip: `${a.label}: ${a.tasksCompleted} task(s) completed, ${a.tasksFailed} failed, ${a.handoffsSent} handoff(s) sent`,
    })),
    'Tasks completed by agent',
  );
}

function dailyChart(data) {
  const counts = new Map();
  for (const w of data.workflows) {
    const d = new Date(w.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (counts.size < 2) {
    return h('p', { className: 'kpi-empty' }, `${NOT_ENOUGH}: a daily trend needs workflows on at least two different days${counts.size === 1 ? ` (all ${data.workflows.length} were submitted on ${[...counts.keys()][0]})` : ''}.`);
  }
  // Every calendar day between the first and last submission (max 31 shown).
  const keys = [...counts.keys()].sort();
  const days = [];
  for (let d = new Date(`${keys[0]}T00:00:00`); days.length < 366; d.setDate(d.getDate() + 1)) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push(key);
    if (key === keys[keys.length - 1]) break;
  }
  const shown = days.slice(-31);
  const max = Math.max(...shown.map((k) => counts.get(k) || 0));
  return [
    h(
      'div',
      { className: 'columns-chart', role: 'list', 'aria-label': 'Workflows submitted per day' },
      shown.map((key) => {
        const n = counts.get(key) || 0;
        return attachTooltip(
          h('div', { className: 'column', role: 'listitem' }, h('span', { className: 'column-fill', style: `height:${(n / max) * 100}%;background:${SERIES_COLOR}` })),
          `${key}: ${n} workflow${n === 1 ? '' : 's'}`,
        );
      }),
    ),
    h('div', { className: 'columns-axis' }, h('span', null, shown[0]), h('span', null, `max ${max} per day`), h('span', null, shown[shown.length - 1])),
    days.length > shown.length ? h('p', { className: 'muted small' }, `Showing the last ${shown.length} of ${days.length} days.`) : null,
  ];
}

function agentTable(data) {
  return h(
    'section',
    { className: 'chart-panel' },
    h('div', { className: 'kpi-head' }, h('h2', null, 'Agent activity details'), sourceBadge('calculated')),
    h('p', { className: 'muted small' }, 'Counts are read from the tasks and handoff events; execution times are calculated from recorded task start and finish times.'),
    h('div', { className: 'table-scroll' }, h(
      'table',
      { className: 'data' },
      h('thead', null, h('tr', null, ['Agent', 'Tasks completed', 'Tasks failed', 'Interrupted', 'Handoffs sent', 'Blocks caused', 'Total execution', 'Average task'].map((c) => h('th', null, c)))),
      h(
        'tbody',
        null,
        data.agents.map((a) =>
          h(
            'tr',
            null,
            h('td', null, h('strong', null, a.label)),
            h('td', { className: 'num' }, a.tasksCompleted),
            h('td', { className: 'num' }, a.tasksFailed),
            h('td', { className: 'num' }, a.tasksInterrupted),
            h('td', { className: 'num' }, a.handoffsSent),
            h('td', { className: 'num' }, a.blocksCaused),
            h('td', { className: 'num' }, a.executionMs == null ? NOT_ENOUGH : duration(a.executionMs)),
            h('td', { className: 'num' }, a.averageTaskMs == null ? NOT_ENOUGH : duration(a.averageTaskMs)),
          ),
        ),
      ),
    )),
  );
}

function transparency(data) {
  return h(
    'section',
    { className: 'chart-panel' },
    h('div', { className: 'kpi-head' }, h('h2', { className: 'with-icon' }, icon('analysis'), 'How these numbers are calculated')),
    h(
      'table',
      { className: 'data' },
      h('thead', null, h('tr', null, h('th', null, 'Metric'), h('th', null, 'Type'), h('th', null, 'Source and calculation'))),
      h('tbody', null, data.kpis.map((k) => h('tr', null, h('td', null, k.label), h('td', null, sourceBadge(k.source)), h('td', null, k.basis)))),
    ),
    h('h3', { className: 'an-subhead' }, 'Notes'),
    h('ul', { className: 'issues' }, data.notes.map((n) => h('li', null, n))),
    h('h3', { className: 'an-subhead' }, 'Not available yet'),
    h('ul', { className: 'issues' }, data.notAvailable.map((n) => h('li', null, n))),
  );
}

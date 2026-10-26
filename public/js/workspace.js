// Workspace layout: navigation, top bar, the Product Workspace conversation,
// the right-hand rail and the shortcut cards. The conversation is built
// only from recorded events; agent messages are labelled as scripted.

import { duration, h, icon, last, mount, shortTime, time } from './dom.js';
import {
  EXECUTION_LABEL,
  CATEGORY_ICON,
  STEP_MARK,
  agentLabel,
  criteriaList,
  kindBadge,
  outcomeStep,
  progressBanner,
  stageStates,
  statusLabel,
} from './views.js';

export const ROUTES = [
  { id: 'home', label: 'Home', icon: 'home', hash: '#/' },
  { id: 'projects', label: 'Projects', icon: 'folder', hash: '#/projects' },
  { id: 'requirements', label: 'Requirements', icon: 'analysis', hash: '#/requirements' },
  { id: 'team', label: 'Team', icon: 'team', hash: '#/team' },
  { id: 'activity', label: 'Team Activity', icon: 'activity', hash: '#/activity' },
  { id: 'repository', label: 'Repository', icon: 'repository', hash: '#/repository' },
  { id: 'analytics', label: 'Analytics', icon: 'analytics', hash: '#/analytics' },
];

// ---- Sidebar ------------------------------------------------------------------------

export function renderNav(ui) {
  mount(
    'nav',
    ROUTES.map((route) =>
      h('a', { href: route.hash, 'aria-current': ui.route === route.id ? 'page' : null }, icon(route.icon), route.label),
    ),
  );
}

/** One honest line about how the agents currently decide. */
export function teamModeText(state) {
  const ai = state.agents.filter((a) => a.mode === 'ai').map((a) => a.label);
  if (!ai.length) return 'Scripted agents · no AI model';
  return `${ai.join(' and ')}: AI-powered (Claude Code) · QA: scripted`;
}

export function renderSidebarStatus(state, ui) {
  const connection = { live: 'Live updates connected', connecting: 'Connecting…', offline: 'Reconnecting…' }[ui.connection];
  mount(
    'sidebar-status',
    h(
      'div',
      { className: 'status-card' },
      h('span', { className: 'avatar avatar-qa' }, icon('local')),
      h(
        'div',
        null,
        h('strong', null, 'Local workspace'),
        h('span', { className: 'line' }, teamModeText(state)),
        h('span', { className: 'line' }, h('span', { className: 'dot', style: `background: var(--${ui.connection === 'live' ? 'success' : ui.connection === 'offline' ? 'danger' : 'warning'})` }), connection),
      ),
    ),
    h('p', { className: 'tagline' }, 'Your ideas.', h('br'), state.agents.some((a) => a.mode === 'ai') ? 'An AI-assisted team.' : 'A scripted team.', h('br'), 'Real, verified files.'),
  );
}

// ---- Top bar ------------------------------------------------------------------------

export function renderTopbar(state, detail) {
  const workflow = detail && detail.workflow;
  mount(
    'project-card',
    h('span', { className: 'project-icon' }, icon('chat')),
    h(
      'div',
      { style: 'min-width: 0' },
      h(
        'div',
        { className: 'project-line' },
        h('span', { className: 'project-label' }, 'Project:'),
        h('span', { className: 'project-name' }, workflow ? workflow.title : 'No project yet'),
        workflow && h('span', { className: 'status-pill', dataset: { status: workflow.status } }, statusLabel(state, workflow.status)),
      ),
      h('div', { className: 'project-request' }, workflow ? workflow.requestText : 'Describe what you would like to build to start a workflow.'),
    ),
  );
  renderElapsed(detail);
}

/** Elapsed time from the workflow's recorded start to its end (or now while active). */
export function renderElapsed(detail) {
  const el = document.getElementById('elapsed');
  const workflow = detail && detail.workflow;
  if (!workflow) {
    el.hidden = true;
    return;
  }
  const end = workflow.finishedAt ? new Date(workflow.finishedAt) : ['running', 'blocked'].includes(workflow.status) ? new Date() : new Date(workflow.updatedAt);
  el.hidden = false;
  mount(el, icon('clock'), duration(end - new Date(workflow.createdAt)));
}

// ---- Home: Product Workspace ------------------------------------------------------------

/** Builds the static home skeleton once per visit, so the composer keeps its text. */
export function mountHome(ui, actions) {
  const textarea = h('textarea', {
    id: 'request-input',
    rows: 2,
    maxlength: 2000,
    placeholder: 'Describe what you would like to build, e.g. "Build a simple Hello World web application."',
    'aria-labelledby': 'composer-heading',
    oninput: (e) => {
      ui.draft = e.target.value;
      document.getElementById('char-count').textContent = `${ui.draft.length} / 2000`;
    },
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        actions.submit();
      }
    },
  });
  textarea.value = ui.draft;

  mount(
    'view',
    h(
      'section',
      { className: 'panel workspace', 'aria-labelledby': 'workspace-heading' },
      h(
        'div',
        { className: 'workspace-head' },
        h('span', { className: 'project-icon' }, icon('chat')),
        h(
          'div',
          { className: 'grow' },
          h('h1', { id: 'workspace-heading', className: 'workspace-title' }, 'Product Workspace'),
          h('p', { className: 'muted' }, 'Describe what you want to build. The PO, Developer and QA take it from there, and every step is recorded.'),
        ),
        h('span', { id: 'workspace-kind' }),
      ),
      h('div', { id: 'tracker', className: 'tracker' }),
      h('ol', { id: 'conversation', className: 'conversation', 'aria-live': 'polite' }),
      h(
        'form',
        {
          className: 'composer',
          novalidate: true,
          onsubmit: (e) => {
            e.preventDefault();
            actions.submit();
          },
        },
        h('h2', { id: 'composer-heading', className: 'sr-only' }, 'What would you like to build?'),
        h(
          'div',
          { className: 'composer-target' },
          h('label', { className: 'muted small', for: 'request-input', style: 'font-weight:600;color:var(--text-soft)' }, 'What would you like to build?'),
          h(
            'label',
            { className: 'product-picker' },
            h('span', { className: 'muted small' }, 'For'),
            h('select', { id: 'product-target', 'aria-label': 'New product or change to an existing product', onchange: (e) => actions.setTarget(e.target.value || null) }),
          ),
        ),
        h(
          'div',
          { className: 'composer-box' },
          textarea,
          h('button', { id: 'start-button', className: 'btn btn-primary', type: 'submit' }, 'Start workflow', icon('send')),
        ),
        h('div', { className: 'composer-meta' }, h('span', { id: 'supported' }), h('span', { id: 'char-count' }, `${ui.draft.length} / 2000`)),
        h('div', { id: 'request-feedback', className: 'feedback', role: 'status', 'aria-live': 'polite' }),
      ),
    ),
    h('div', { id: 'shortcuts', className: 'shortcuts' }),
  );
}

export function renderTracker(state, detail) {
  if (!detail) {
    mount('tracker', h('span', { className: 'muted small' }, 'Stages appear here when a workflow starts: requirement analysis, implementation, verification, correction (only if QA finds defects), final review.'));
    return;
  }
  const steps = stageStates(state, detail).concat(outcomeStep(state, detail.workflow));
  mount(
    'tracker',
    h(
      'ol',
      { className: 'stepper', 'aria-label': 'Workflow stages' },
      steps.map((step) =>
        h(
          'li',
          { className: 'step', dataset: { state: step.value }, title: `${step.title}: ${step.note}` },
          h('div', { className: 'step-top' }, h('span', { className: 'step-mark', 'aria-hidden': 'true' }, STEP_MARK[step.value]), h('span', { className: 'step-title' }, step.title)),
          h('div', { className: 'step-meta' }, (step.agent ? `${agentLabel(state, step.agent)} · ` : '') + step.note),
        ),
      ),
    ),
  );
}

function avatarFor(actor) {
  return h('span', { className: `avatar avatar-${actor === 'user' ? 'user' : actor}` }, icon(actor === 'user' ? 'user' : actor));
}

function agentMessage(state, event, body, extra) {
  return h(
    'li',
    { className: 'msg msg-agent' },
    avatarFor(event.actor),
    h(
      'div',
      { className: 'bubble' },
      h(
        'div',
        { className: 'msg-head' },
        h('span', { className: 'who' }, agentLabel(state, event.actor)),
        event.to ? h('span', { className: 'muted' }, `→ ${agentLabel(state, event.to)}`) : null,
        kindBadge(event.actorKind),
        h('time', { datetime: event.ts }, time(event.ts)),
      ),
      body,
      extra || null,
    ),
  );
}

function note(event, text) {
  return h(
    'li',
    { className: 'note', dataset: { status: event.status } },
    icon(CATEGORY_ICON[event.category] || 'system'),
    h('span', null, h('span', { className: 'muted' }, `${time(event.ts)} · `), text || event.summary),
  );
}

/** Turns recorded events into conversation items. Technical events stay in the activity log. */
function conversationItems(state, detail, ui, actions) {
  const { workflow, events, tasks } = detail;
  const items = [];
  const lastBlocked = last(events.filter((e) => e.type === 'workflow.blocked'));
  const defectsByTask = {};
  events.filter((e) => e.type === 'defect.reported').forEach((e) => (defectsByTask[e.taskId] = (defectsByTask[e.taskId] || []).concat(e)));

  for (const event of events) {
    const d = event.detail || {};
    switch (event.type) {
      case 'request.submitted':
        items.push(
          h(
            'li',
            { className: 'msg msg-user' },
            avatarFor('user'),
            h('div', { className: 'bubble' }, h('div', { className: 'msg-head' }, h('span', { className: 'who' }, 'You'), kindBadge('human'), h('time', { datetime: event.ts }, time(event.ts))), d.baseVersion ? h('p', { className: 'muted small' }, `Change request on requirements v${d.baseVersion}`) : null, h('p', null, d.requestText)),
          ),
        );
        break;
      case 'po.requirements':
        items.push(
          agentMessage(
            state,
            event,
            [
              h('p', null, event.summary),
              h('ol', { className: 'plan' }, d.requirements.map((r, i) => h('li', null, h('span', { className: 'num' }, i + 1), h('span', null, r)))),
              h('p', { className: 'muted small' }, 'Acceptance criteria'),
              h('ol', { className: 'plan' }, d.acceptanceCriteria.map((c) => h('li', null, h('span', { className: 'num ac' }, c.id), h('span', null, c.description)))),
            ],
          ),
        );
        break;
      case 'po.clarification':
        items.push(
          agentMessage(
            state,
            event,
            [h('p', null, event.summary), h('ul', { className: 'plan' }, (d.supported || []).map((r) => h('li', null, h('span', { className: 'num' }, '✓'), h('span', null, h('strong', null, r.title), ` — ${r.summary}`))))],
            workflow.status === 'needs_clarification'
              ? h('div', { style: 'margin-top:10px' }, h('button', { type: 'button', className: 'btn btn-sm', onclick: () => actions.fillRequest(workflow.requestText) }, 'Edit my request'))
              : null,
          ),
        );
        break;
      case 'dev.implementation':
      case 'dev.correction':
        items.push(agentMessage(state, event, [h('p', null, event.summary), h('ul', { className: 'plan' }, d.files.map((f) => h('li', null, h('span', { className: 'num ac' }, f.change === 'created' ? 'new' : f.change === 'modified' ? 'mod' : '='), h('span', { className: 'mono' }, f.path))))]));
        break;
      case 'qa.verdict': {
        const defects = defectsByTask[event.taskId] || [];
        items.push(
          agentMessage(state, event, [
            h('p', null, event.summary),
            h('ol', { className: 'plan' }, d.criteria.map((c) => h('li', null, h('span', { className: `num ${c.status}` }, c.status === 'pass' ? '✓' : '✕'), h('span', null, h('strong', null, `${c.id} `), c.description)))),
            defects.length ? [h('p', { className: 'muted small' }, 'Defects reported'), h('ul', { className: 'plan' }, defects.map((x) => h('li', null, h('span', { className: 'num fail' }, '!'), h('span', null, x.summary))))] : null,
          ]),
        );
        break;
      }
      case 'po.review':
        items.push(
          agentMessage(
            state,
            event,
            h('p', null, event.summary),
            d.decidedBy === 'rule' ? h('p', { className: 'muted small' }, 'Acceptance rule, not an AI decision: the PO accepts only when QA has verified every criterion.') : null,
          ),
        );
        break;
      case 'handoff':
        items.push(
          h(
            'li',
            { className: 'handoff-card', dataset: { status: event.status } },
            icon('handoff'),
            h(
              'div',
              null,
              h('div', { className: 'handoff-route' }, agentLabel(state, event.from), h('span', { 'aria-label': 'to' }, '→'), agentLabel(state, event.to), kindBadge(event.actorKind), h('span', { className: 'muted small' }, time(event.ts))),
              h('div', null, event.summary),
            ),
          ),
        );
        break;
      case 'workflow.blocked':
        if (event === lastBlocked && workflow.status === 'blocked') items.push(h('li', null, progressBanner(state, workflow, ui, actions)));
        else items.push(note(event));
        break;
      case 'workflow.created':
      case 'workflow.resumed':
      case 'workflow.cancelled':
      case 'workflow.completed':
      case 'workflow.failed':
      case 'workflow.needs_clarification':
      case 'workflow.interrupted':
      case 'agent.enabled':
      case 'agent.disabled':
      case 'agent.mode':
      case 'task.failed':
      case 'git.unavailable':
      case 'git.failed':
        items.push(note(event));
        break;
      default:
        break;
    }
  }

  if (workflow.status === 'interrupted') items.push(h('li', null, progressBanner(state, workflow, ui, actions)));
  const running = tasks.find((t) => t.status === 'running');
  if (running) {
    items.push(h('li', { className: 'live-line' }, h('span', { className: 'dot' }), `${agentLabel(state, running.agentId)} is working: ${running.title.toLowerCase()}…`));
  }
  return items;
}

export function renderConversation(state, detail, ui, actions) {
  const list = document.getElementById('conversation');
  const nearBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
  if (!detail) {
    mount(
      list,
      h('li', { className: 'empty' }, 'No conversation yet. Write your requirement below, for example "Build a simple Hello World web application.", and click Start workflow.'),
      state.workspaceEvents.length ? state.workspaceEvents.map((e) => note(e)) : null,
    );
    return;
  }
  const items = conversationItems(state, detail, ui, actions);
  const before = list.childElementCount;
  mount(list, items);
  if (nearBottom || items.length > before) list.scrollTop = list.scrollHeight;
}

export function renderComposer(state, ui, actions) {
  const input = document.getElementById('request-input');
  const button = document.getElementById('start-button');
  if (!input) return;
  const active = state.workflows.find((w) => w.id === state.activeWorkflowId);
  input.disabled = ui.submitting;
  button.disabled = ui.submitting || Boolean(active);

  const target = state.products.find((p) => p.id === ui.targetProductId) || null;
  mount(
    'product-target',
    h('option', { value: '', selected: !target }, 'A new product'),
    state.products.filter((p) => p.versions > 0).map((p) => h('option', { value: p.id, selected: target && p.id === target.id }, `Change: ${p.title} (v${p.versions})`)),
  );
  input.placeholder = target
    ? `Describe the change to "${target.title}", e.g. "Make the text blue" or "Add a button that…"`
    : 'Describe what you would like to build, e.g. "Build a simple Hello World web application."';
  button.firstChild.textContent = ui.submitting ? 'Starting…' : target ? 'Request change' : 'Start workflow';

  const anyAi = state.agents.some((a) => a.mode === 'ai');
  mount('workspace-kind', anyAi ? kindBadge('ai', state.ai.model) : kindBadge('scripted'));
  const poAi = state.agents.some((a) => a.id === 'po' && a.mode === 'ai');
  if (target) {
    mount(
      'supported',
      poAi
        ? `Change request: the PO starts from requirements v${target.versions} and the Developer from the current files. QA re-checks every criterion.`
        : 'Change requests need the PO and the Developer in AI-powered mode (Team page).',
    );
    return finishComposer(state, ui, active);
  }
  if (poAi) {
    mount('supported', 'The PO is AI-powered: describe any static web page (HTML, CSS, JavaScript).');
    return finishComposer(state, ui, active);
  }
  mount(
    'supported',
    'Supported now: ',
    state.recipes.map((recipe, i) => [
      i > 0 ? ', ' : '',
      h('button', { type: 'button', className: 'link-button', title: recipe.summary, onclick: () => actions.fillRequest(recipe.examples[1] || recipe.examples[0]) }, recipe.title),
    ]),
  );

  finishComposer(state, ui, active);
}

function finishComposer(state, ui, active) {
  const feedback = document.getElementById('request-feedback');
  let message = ui.feedback;
  if (!message && active) {
    message = {
      tone: 'info',
      text:
        active.status === 'blocked'
          ? `"${active.title}" is blocked. This milestone runs one workflow at a time: resume or cancel it before starting a new request.`
          : `"${active.title}" is running. This milestone runs one workflow at a time; you can start a new request when it finishes.`,
    };
  }
  feedback.dataset.tone = message ? message.tone : '';
  feedback.textContent = message ? message.text : '';
}

// ---- Shortcut cards ---------------------------------------------------------------------

function chip(tone, text) {
  return h('span', { className: 'chip', dataset: { tone } }, h('span', { className: 'dot' }), text);
}

export function renderShortcuts(state, detail, ui) {
  const el = document.getElementById('shortcuts');
  if (!el) return;
  const enabled = state.agents.filter((a) => a.enabled).length;
  const events = detail ? detail.events : [];
  const commits = events.filter((e) => e.type === 'git.commit').length;
  const files = detail ? detail.product.files.length : 0;

  let repoChip;
  if (!detail || files === 0) repoChip = chip('neutral', 'No product yet');
  else if (commits) repoChip = chip('success', `${files} files · ${commits} commit${commits === 1 ? '' : 's'}`);
  else if (!state.git.available) repoChip = chip('warning', `${files} files · Git unavailable`);
  else repoChip = chip('neutral', `${files} files`);

  const card = (href, tone, iconName, title, text, status) =>
    h(
      href ? 'a' : 'div',
      { className: 'shortcut', href, 'aria-disabled': href ? null : 'true' },
      h('span', { className: `shortcut-icon ${tone}` }, icon(iconName)),
      h('span', { className: 'shortcut-title' }, title, href ? icon('chevron') : null),
      h('p', null, text),
      status,
    );

  const previewCard = () => {
    const p = previewFor(state, detail);
    const node = card('#/', 'tone-blue', 'preview', 'Live Preview', 'The generated product running locally on its own preview server.', chip(PREVIEW_TONE[p.status], PREVIEW_LABEL[p.status]));
    node.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('preview-slot').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return node;
  };

  mount(
    el,
    card('#/team', 'tone-violet', 'team', 'AI Scrum Team', 'Roles, availability and current work of the PO, Developer and QA.', chip(enabled === state.agents.length ? 'success' : 'warning', `${state.agents.length} agents · ${enabled} enabled`)),
    card('#/activity', 'tone-cyan', 'activity', 'Team Activity', 'Recorded events, handoffs, commands and decisions.', chip(ui.connection === 'live' ? 'success' : 'danger', ui.connection === 'live' ? `Live · ${events.length} events` : 'Not connected')),
    previewCard(state, detail),
    card('#/repository', 'tone-orange', 'repository', 'Repository', 'Generated files, test results and Git commits of the product.', repoChip),
  );
}

// ---- Rail ---------------------------------------------------------------------------

export function renderRail(state, detail, ui, actions) {
  mount('rail-team-icon', icon('team'));
  document.getElementById('team-note').textContent = state.agents.some((a) => a.mode === 'ai')
    ? `${teamModeText(state)}. Model: ${state.ai.model}.`
    : 'Scripted agents: fixed rules and templates, no AI model.';
  mount('rail-activity-icon', icon('activity'));
  const enabled = state.agents.filter((a) => a.enabled).length;
  const summary = document.getElementById('team-summary');
  summary.dataset.tone = enabled === state.agents.length ? 'success' : 'warning';
  mount(summary, h('span', { className: 'dot' }), `${enabled} of ${state.agents.length} enabled`);

  mount(
    'team-rows',
    state.agents.map((agent) =>
      h(
        'li',
        { className: 'team-row', dataset: { exec: agent.execution } },
        avatarFor(agent.id),
        h(
          'div',
          { style: 'min-width:0' },
          h('div', { className: 'team-row-name' }, agent.label, ' ', h('span', { className: 'muted' }, agent.title === agent.label ? '' : agent.title), ' ', agent.kind === 'ai' ? kindBadge('ai', state.ai.model) : null),
          h('div', { className: 'team-row-activity', title: agent.activity }, agent.finishingTask ? `Disabled · finishing "${agent.finishingTask}"` : agent.activity),
          h(
            'div',
            { className: 'state-row' },
            h('span', { className: 'state availability', dataset: { value: agent.enabled ? 'enabled' : 'disabled' }, title: 'Availability (configuration)' }, agent.enabled ? 'Enabled' : 'Disabled'),
            h('span', { className: 'state execution', dataset: { value: agent.execution }, title: 'Execution status' }, h('span', { className: 'dot' }), EXECUTION_LABEL[agent.execution]),
          ),
        ),
        h(
          'div',
          { className: 'team-row-controls' },
          h(
            'label',
            { className: 'switch', title: agent.enabled ? `Disable ${agent.label}` : `Enable ${agent.label}` },
            h('input', {
              type: 'checkbox',
              role: 'switch',
              checked: agent.enabled,
              disabled: ui.pendingToggles.has(agent.id),
              'aria-label': `${agent.label} available for assignments`,
              onchange: (e) => actions.toggleAgent(agent.id, e.target.checked),
            }),
            h('span', { className: 'track' }),
          ),
          h('a', { className: 'icon-link', href: '#/team', title: `Details for ${agent.label}`, 'aria-label': `Details for ${agent.label}` }, icon('chevron')),
        ),
      ),
    ),
  );

  const events = (detail ? detail.events : state.workspaceEvents).filter((e) => e.type !== 'command.started');
  const recent = events.slice(-6);
  mount(
    'activity-compact',
    recent.length
      ? recent.map((e) =>
          h(
            'li',
            { className: `activity-item cat-${e.category}`, dataset: { status: e.status } },
            h('span', { className: 'event-icon' }, icon(CATEGORY_ICON[e.category] || 'system')),
            h('time', { datetime: e.ts, title: time(e.ts) }, shortTime(e.ts)),
            h('div', { style: 'min-width:0' }, h('div', { className: 'who' }, e.type === 'handoff' ? `${agentLabel(state, e.from)} → ${agentLabel(state, e.to)}` : agentLabel(state, e.actor)), h('div', { className: 'what', title: e.summary }, e.summary)),
          ),
        )
      : h('li', { className: 'empty' }, 'No activity yet.'),
  );

  renderPreview(state, detail, ui, actions);
}

// ---- Live Preview ---------------------------------------------------------------------

const PREVIEW_LABEL = { not_started: 'Not Started', starting: 'Starting', running: 'Running', error: 'Error' };
const PREVIEW_TONE = { not_started: 'neutral', starting: 'info', running: 'success', error: 'danger' };

/** The preview status that applies to the workflow shown on the dashboard. */
export function previewFor(state, detail) {
  const preview = state.preview;
  const workflow = detail && detail.workflow;
  if (!workflow || preview.workflowId !== workflow.id) return { ...preview, status: 'not_started', url: null, error: null, other: preview.workflowId && preview.status !== 'not_started' ? preview : null };
  return { ...preview, other: null };
}

/**
 * Renders the Live Preview panel. The iframe is kept between renders so the
 * running product is not reloaded on every dashboard update; it is only
 * replaced when the preview URL changes or the user clicks Refresh.
 */
export function renderPreview(state, detail, ui, actions) {
  const slot = document.getElementById('preview-slot');
  if (!slot.dataset.ready) {
    mount(
      slot,
      h('div', { className: 'panel-head' }, h('h2', { id: 'preview-heading', className: 'with-icon' }, icon('preview'), 'Live Preview'), h('span', { id: 'preview-status', className: 'chip' })),
      h('div', { id: 'preview-bar', className: 'preview-bar' }),
      h('div', { id: 'preview-body', className: 'preview-body' }),
    );
    slot.dataset.ready = 'true';
  }
  const workflow = detail && detail.workflow;
  const p = previewFor(state, detail);
  const busy = ui.previewBusy;

  const statusChip = document.getElementById('preview-status');
  statusChip.dataset.tone = PREVIEW_TONE[p.status];
  mount(statusChip, h('span', { className: 'dot' }), PREVIEW_LABEL[p.status]);

  mount(
    'preview-bar',
    h('span', { className: 'preview-dots', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
    h('span', { className: 'preview-url', title: p.url || '' }, p.url ? p.url.replace(/^http:\/\//, '') : 'No preview running'),
    h('button', { type: 'button', className: 'icon-button', title: 'Refresh the preview', 'aria-label': 'Refresh the preview', disabled: busy || !(p.status === 'running' || p.status === 'error'), onclick: () => actions.refreshPreview() }, icon('refresh')),
    h('a', { className: 'icon-button', title: 'Open in a new browser tab', 'aria-label': 'Open the preview in a new browser tab', href: p.status === 'running' ? p.url : null, target: '_blank', rel: 'noopener', 'aria-disabled': p.status === 'running' ? null : 'true' }, icon('external')),
  );

  const body = document.getElementById('preview-body');
  if (p.status === 'running') {
    if (!ui.previewFrame || ui.previewFrame.dataset.url !== p.url || !body.contains(ui.previewFrame)) {
      ui.previewFrame = h('iframe', {
        src: p.url,
        title: `Live preview of ${p.title || 'the generated product'}`,
        sandbox: 'allow-scripts',
        referrerpolicy: 'no-referrer',
        dataset: { url: p.url },
      });
      mount(body, ui.previewFrame, h('p', { className: 'preview-caption' }, `Previewing "${p.title}" · ${p.workflowId}`));
    }
    return;
  }
  ui.previewFrame = null;

  const hasProduct = Boolean(workflow && workflow.recipeId && detail.product.files.length);
  let content;
  if (p.status === 'starting') {
    content = [h('p', null, 'Starting the preview server and checking that the product page loads…')];
  } else if (p.status === 'error') {
    content = [
      h('p', { className: 'preview-error' }, p.error),
      hasProduct ? h('button', { type: 'button', className: 'btn btn-sm', disabled: busy, onclick: () => actions.startPreview(workflow.id) }, 'Try again') : null,
    ];
  } else if (hasProduct) {
    content = [
      h('p', null, `Run the generated product "${workflow.title}" locally, on its own preview server.`),
      p.other ? h('p', { className: 'muted small' }, `The preview currently shows another workflow (${p.other.title || p.other.workflowId}). Starting this one switches the preview.`) : null,
      workflow.verified ? null : h('p', { className: 'muted small' }, 'Note: this product has not been verified by QA.'),
      h('button', { type: 'button', className: 'btn btn-primary btn-sm', disabled: busy, onclick: () => actions.startPreview(workflow.id) }, 'Start preview'),
    ];
  } else {
    content = [h('p', null, workflow ? 'This workflow has not generated a product to preview.' : 'Nothing to preview yet. Start a workflow to generate a product.')];
  }
  mount(body, h('div', { className: 'preview-frame' }, icon('preview'), content));
}

// ---- Secondary view shells -----------------------------------------------------------------

export function mountSection(title, subtitle, bodyId, bodyTag, bodyClass) {
  mount(
    'view',
    h(
      'section',
      { className: 'panel' },
      h('div', { className: 'view-head' }, h('div', null, h('h1', null, title), subtitle ? h('p', { className: 'muted' }, subtitle) : null)),
      h(bodyTag, { id: bodyId, className: bodyClass }),
    ),
  );
}

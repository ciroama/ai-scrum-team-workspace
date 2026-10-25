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
  { id: 'team', label: 'Team', icon: 'team', hash: '#/team' },
  { id: 'activity', label: 'Team Activity', icon: 'activity', hash: '#/activity' },
  { id: 'repository', label: 'Repository', icon: 'repository', hash: '#/repository' },
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
        h('span', { className: 'line' }, 'Scripted agents · no AI model'),
        h('span', { className: 'line' }, h('span', { className: 'dot', style: `background: var(--${ui.connection === 'live' ? 'success' : ui.connection === 'offline' ? 'danger' : 'warning'})` }), connection),
      ),
    ),
    h('p', { className: 'tagline' }, 'Your ideas.', h('br'), 'A scripted team.', h('br'), 'Real, verified files.'),
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
        kindBadge('scripted'),
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
        h('label', { className: 'muted small', for: 'request-input', style: 'display:block;margin-bottom:6px;font-weight:600;color:var(--text-soft)' }, 'What would you like to build?'),
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
            h('div', { className: 'bubble' }, h('div', { className: 'msg-head' }, h('span', { className: 'who' }, 'You'), kindBadge('human'), h('time', { datetime: event.ts }, time(event.ts))), h('p', null, d.requestText)),
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
        items.push(agentMessage(state, event, h('p', null, event.summary)));
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
  button.firstChild.textContent = ui.submitting ? 'Starting…' : 'Start workflow';

  mount(
    'supported',
    'Supported now: ',
    state.recipes.map((recipe, i) => [
      i > 0 ? ', ' : '',
      h('button', { type: 'button', className: 'link-button', title: recipe.summary, onclick: () => actions.fillRequest(recipe.examples[1] || recipe.examples[0]) }, recipe.title),
    ]),
  );

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

  mount(
    el,
    card('#/team', 'tone-violet', 'team', 'AI Scrum Team', 'Roles, availability and current work of the PO, Developer and QA.', chip(enabled === state.agents.length ? 'success' : 'warning', `${state.agents.length} agents · ${enabled} enabled`)),
    card('#/activity', 'tone-cyan', 'activity', 'Team Activity', 'Recorded events, handoffs, commands and decisions.', chip(ui.connection === 'live' ? 'success' : 'danger', ui.connection === 'live' ? `Live · ${events.length} events` : 'Not connected')),
    card(null, 'tone-blue', 'preview', 'Live Preview', 'See the generated product running. Planned for a later milestone.', chip('neutral', 'Not in this milestone')),
    card('#/repository', 'tone-orange', 'repository', 'Repository', 'Generated files, test results and Git commits of the product.', repoChip),
  );
}

// ---- Rail ---------------------------------------------------------------------------

export function renderRail(state, detail, ui, actions) {
  mount('rail-team-icon', icon('team'));
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
          h('div', { className: 'team-row-name' }, agent.label, ' ', h('span', { className: 'muted' }, agent.title === agent.label ? '' : agent.title)),
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

  mount(
    'preview-slot',
    h('div', { className: 'panel-head' }, h('h2', { id: 'preview-heading', className: 'with-icon' }, icon('preview'), 'Live Preview'), h('span', { className: 'chip' }, 'Not in this milestone')),
    h(
      'div',
      { className: 'preview-frame' },
      icon('preview'),
      h('p', null, 'A live preview of the generated product is planned for a later milestone.'),
      detail && detail.product.files.length ? h('p', null, h('a', { className: 'link-button', href: '#/repository' }, 'Open the generated files in Repository')) : null,
    ),
  );
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

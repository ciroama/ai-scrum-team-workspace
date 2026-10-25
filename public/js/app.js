// Dashboard controller: routing, data loading, live updates and user
// actions. Plain browser JavaScript modules, no build step; kept to
// features available in Safari 16 and Chrome on macOS 11.

import { dateTime, duration, h, icon, mount } from './dom.js';
import { renderResults, renderTeam, renderTimeline, statusLabel, verificationBadge } from './views.js';
import * as ws from './workspace.js';

const ui = {
  route: 'home',
  mountedRoute: null,
  selectedId: null,
  pinned: false, // true when the user picked an older workflow in Projects
  draft: '',
  submitting: false,
  feedback: null,
  connection: 'connecting',
  pendingToggles: new Set(),
  pendingAction: null,
  open: new Set(),
  renderedEvents: new Set(),
};
let state = null;
let detail = null;

// ---- data -------------------------------------------------------------------------------

async function api(path, options) {
  const res = await fetch(path, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON response
  }
  if (!res.ok) {
    const error = new Error((body && body.error) || `${res.status} ${res.statusText}`);
    error.status = res.status;
    throw error;
  }
  return body;
}

function showError(message) {
  const el = document.getElementById('global-error');
  el.hidden = !message;
  el.textContent = message || '';
}

let refreshing = false;
let refreshAgain = false;
async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    state = await api('/api/state');
    if (!ui.pinned || !state.workflows.some((w) => w.id === ui.selectedId)) {
      ui.selectedId = state.focusWorkflowId;
      ui.pinned = false;
    }
    detail = ui.selectedId ? await api(`/api/workflows/${ui.selectedId}`) : null;
    showError(null);
    render();
  } catch (error) {
    showError(`Could not load the workspace: ${error.message}. Is the server still running? Start it with "npm start".`);
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      refresh();
    }
  }
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 120);
}

// ---- actions -------------------------------------------------------------------------------

const actions = {
  async submit() {
    if (ui.submitting) return;
    const text = ui.draft.trim();
    if (!text) {
      ui.feedback = { tone: 'error', text: 'Please describe what you would like to build.' };
      render();
      return;
    }
    ui.submitting = true;
    ui.feedback = null;
    render();
    try {
      const { workflow } = await api('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: text }),
      });
      ui.draft = '';
      const input = document.getElementById('request-input');
      if (input) input.value = '';
      const counter = document.getElementById('char-count');
      if (counter) counter.textContent = '0 / 2000';
      ui.selectedId = workflow.id;
      ui.pinned = false;
      const started = { tone: 'success', text: 'Workflow started. Follow the team in the conversation above.' };
      ui.feedback = started;
      setTimeout(() => {
        if (ui.feedback === started) {
          ui.feedback = null;
          render();
        }
      }, 6000);
    } catch (error) {
      ui.feedback = { tone: 'error', text: error.status ? error.message : `The workflow could not be created: ${error.message}` };
    } finally {
      ui.submitting = false;
      await refresh();
    }
  },

  async toggleAgent(agentId, enabled) {
    ui.pendingToggles.add(agentId);
    render();
    try {
      await api(`/api/agents/${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
    } catch (error) {
      showError(`Could not change the agent configuration: ${error.message}`);
    } finally {
      ui.pendingToggles.delete(agentId);
      await refresh();
    }
  },

  async resume(workflowId) {
    await workflowAction(workflowId, 'resume');
  },

  async cancel(workflowId) {
    if (!window.confirm('Cancel this workflow? Its recorded history and generated files are kept, but it will not continue.')) return;
    await workflowAction(workflowId, 'cancel');
  },

  select(workflowId) {
    if (!workflowId || (state && workflowId === state.focusWorkflowId)) {
      ui.pinned = false;
      ui.selectedId = state ? state.focusWorkflowId : null;
    } else {
      ui.pinned = true;
      ui.selectedId = workflowId;
    }
    refresh();
  },

  fillRequest(text) {
    ui.draft = text;
    ui.feedback = null;
    if (ui.route !== 'home') location.hash = '#/';
    else render();
    setTimeout(() => {
      const input = document.getElementById('request-input');
      if (input) {
        input.value = text;
        input.focus();
      }
    }, 0);
  },
};

async function workflowAction(workflowId, action) {
  ui.pendingAction = workflowId;
  render();
  try {
    await api(`/api/workflows/${workflowId}/${action}`, { method: 'POST' });
  } catch (error) {
    showError(error.message);
  } finally {
    ui.pendingAction = null;
    await refresh();
  }
}

// ---- views ---------------------------------------------------------------------------------

function mountRoute() {
  ui.mountedRoute = ui.route;
  switch (ui.route) {
    case 'home':
      ws.mountHome(ui, actions);
      break;
    case 'team':
      mount(
        'view',
        h(
          'section',
          { className: 'panel' },
          h('div', { className: 'view-head' }, h('div', null, h('h1', null, 'AI Scrum Team'), h('p', { className: 'muted' }, 'Three scripted agents and you. Enable or disable an agent to change which work it can be assigned.'))),
          h('div', { className: 'team-grid' }, h('div', { id: 'human-card' }), h('div', { id: 'agent-cards', className: 'agent-cards' })),
        ),
      );
      break;
    case 'projects':
      ws.mountSection('Projects', 'Every workflow you have started, newest first. Select one to inspect it.', 'projects', 'ol', 'project-list');
      break;
    case 'activity':
      ws.mountSection('Team Activity', 'Everything recorded for the workflow shown in the project header, with evidence.', 'timeline', 'ol', 'timeline');
      break;
    case 'repository':
      ws.mountSection('Repository', 'The generated product: files read from disk, test results and Git commits.', 'results', 'div', 'results');
      break;
    default:
      break;
  }
}

function renderProjects() {
  if (!state.workflows.length) {
    mount('projects', h('li', { className: 'empty' }, 'No workflows yet. Start one from Home.'));
    return;
  }
  mount(
    'projects',
    state.workflows.map((wf) =>
      h(
        'li',
        null,
        h(
          'button',
          {
            type: 'button',
            className: 'project-item',
            'aria-current': wf.id === ui.selectedId ? 'true' : 'false',
            onclick: () => {
              actions.select(wf.id);
              location.hash = '#/';
            },
          },
          h(
            'span',
            null,
            h('strong', null, wf.title),
            h('span', { className: 'muted small', style: 'display:block' }, `“${wf.requestText}”`),
            h('span', { className: 'muted small', style: 'display:block' }, `${dateTime(wf.createdAt)}${wf.finishedAt ? ` · took ${duration(new Date(wf.finishedAt) - new Date(wf.createdAt))}` : ''} · ${wf.id}`),
          ),
          h('span', { className: 'badges' }, h('span', { className: 'status-pill', dataset: { status: wf.status } }, statusLabel(state, wf.status)), verificationBadge(wf)),
        ),
      ),
    ),
  );
}

function render() {
  if (!state) return;
  ws.renderNav(ui);
  ws.renderSidebarStatus(state, ui);
  ws.renderTopbar(state, detail);
  ws.renderRail(state, detail, ui, actions);
  if (ui.mountedRoute !== ui.route) mountRoute();

  switch (ui.route) {
    case 'home':
      ws.renderTracker(state, detail);
      ws.renderConversation(state, detail, ui, actions);
      ws.renderComposer(state, ui, actions);
      ws.renderShortcuts(state, detail, ui);
      break;
    case 'team':
      renderTeam(state, ui, actions);
      break;
    case 'projects':
      renderProjects();
      break;
    case 'activity':
      renderTimeline(state, detail, ui);
      break;
    case 'repository':
      renderResults(state, detail, ui);
      break;
    default:
      break;
  }
}

// ---- startup --------------------------------------------------------------------------------

function routeFromHash() {
  const id = location.hash.replace(/^#\/?/, '') || 'home';
  return ws.ROUTES.some((r) => r.id === id) ? id : 'home';
}

window.addEventListener('hashchange', () => {
  ui.route = routeFromHash();
  render();
  document.getElementById('view').focus({ preventScroll: true });
});

document.getElementById('new-request').addEventListener('click', () => {
  ui.feedback = null;
  if (ui.pinned) actions.select(null);
  if (ui.route !== 'home') location.hash = '#/';
  setTimeout(() => {
    const input = document.getElementById('request-input');
    if (input) {
      input.focus();
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, 0);
});

mount('user-avatar', icon('user'));

function connect() {
  const source = new EventSource('/api/stream');
  source.onopen = () => {
    ui.connection = 'live';
    refresh();
  };
  source.onerror = () => {
    ui.connection = 'offline';
    render();
  };
  source.addEventListener('workflow-event', scheduleRefresh);
  source.addEventListener('change', scheduleRefresh);
}

setInterval(() => ws.renderElapsed(detail), 1000);
ui.route = routeFromHash();
refresh();
connect();

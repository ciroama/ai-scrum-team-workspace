// Dashboard controller: routing, data loading, live updates and user
// actions. Plain browser JavaScript modules, no build step; kept to
// features available in Safari 16 and Chrome on macOS 11.

import { h, icon, mount } from './dom.js';
import { renderResults, renderTeam, renderTimeline } from './views.js';
import * as ws from './workspace.js';
import { analyticsQuery, mountAnalytics, renderAnalytics } from './analytics.js';
import { mountAiPanel, renderAiStatus } from './aiPanel.js';
import { mountProjects, mountRequirements, renderProjects, renderRequirements } from './products.js';

const ui = {
  route: 'home',
  mountedRoute: null,
  selectedId: null,
  pinned: false, // true when the user picked an older workflow in Projects
  // An empty workspace for a new product: on opening the dashboard, after
  // "New request", and after deleting the product on screen.
  blank: true,
  loaded: false,
  targetProductId: null, // the product the next request changes; null = a new product
  answering: null, // the request whose PO question the next message answers
  deleting: null, // product id being deleted ('*' for all)
  requirementsProductId: null,
  requirements: null,
  draft: '',
  submitting: false,
  feedback: null,
  connection: 'connecting',
  pendingToggles: new Set(),
  pendingModes: new Set(),
  aiMessage: null,
  pendingAction: null,
  previewBusy: false,
  analyticsFilter: { projectId: 'all', from: '', to: '' },
  analytics: null,
  analyticsError: null,
  previewFrame: null,
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
    // Work in progress (running or blocked) is shown on opening, not hidden.
    if (!ui.loaded && state.activeWorkflowId) ui.blank = false;
    ui.loaded = true;
    if (ui.blank) {
      ui.selectedId = null;
      ui.pinned = false;
    } else if (!ui.pinned || !state.workflows.some((w) => w.id === ui.selectedId)) {
      ui.selectedId = state.focusWorkflowId;
      ui.pinned = false;
    }
    detail = ui.selectedId ? await api(`/api/workflows/${ui.selectedId}`) : null;
    // "For" follows what is on screen: a product with agreed requirements is
    // the target of the next request (a change); otherwise a new product.
    const shown = detail && state.products.find((p) => p.id === detail.workflow.productId);
    ui.targetProductId = shown && shown.versions > 0 ? shown.id : null;
    // A request whose PO is waiting for an answer: the next message answers it.
    ui.answering = detail && detail.workflow.status === 'needs_clarification' ? detail.workflow.id : null;
    if (ui.route === 'analytics') await loadAnalytics();
    if (ui.route === 'requirements') await loadRequirements();
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
      const { workflow } = ui.answering
        ? await api(`/api/workflows/${ui.answering}/answer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ answer: text }),
          })
        : await api('/api/workflows', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ request: text, productId: ui.targetProductId }),
          });
      ui.blank = false;
      ui.draft = '';
      const input = document.getElementById('request-input');
      if (input) input.value = '';
      const counter = document.getElementById('char-count');
      if (counter) counter.textContent = '0 / 2000';
      ui.selectedId = workflow.id;
      ui.pinned = false;
      const started = { tone: 'success', text: ui.answering ? 'Answer sent. The PO continues this request.' : 'Workflow started. Follow the team in the conversation above.' };
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

  async setAgentMode(agentId, mode) {
    ui.pendingModes.add(agentId);
    render();
    try {
      await api(`/api/agents/${agentId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
    } catch (error) {
      showError(`Could not change how the agent works: ${error.message}`);
    } finally {
      ui.pendingModes.delete(agentId);
      await refresh();
    }
  },

  async saveAi(changes) {
    try {
      await api('/api/ai', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) });
      ui.aiMessage = { tone: 'success', text: 'Saved. Click "Test connection" to check it with a real request.' };
    } catch (error) {
      ui.aiMessage = { tone: 'error', text: error.message };
    }
    await refresh();
  },

  async testAi() {
    ui.aiMessage = { tone: 'info', text: 'Sending a test request to Claude Code…' };
    render();
    try {
      const result = await api('/api/ai/test', { method: 'POST' });
      ui.aiMessage = { tone: result.ok ? 'success' : 'error', text: result.message };
    } catch (error) {
      ui.aiMessage = { tone: 'error', text: error.message };
    }
    await refresh();
  },

  async resume(workflowId) {
    await workflowAction(workflowId, 'resume');
  },

  async cancel(workflowId) {
    if (!window.confirm('Cancel this workflow? Its recorded history and generated files are kept, but it will not continue.')) return;
    await workflowAction(workflowId, 'cancel');
  },

  async startPreview(workflowId) {
    await previewAction('/api/preview', { workflowId });
  },

  async refreshPreview() {
    const status = await previewAction('/api/preview/refresh');
    // Reload the running page even when its URL did not change.
    if (status && status.status === 'running' && ui.previewFrame) ui.previewFrame.src = status.url;
  },

  async setAnalyticsFilter(filter, updateInputs) {
    ui.analyticsFilter = filter;
    if (updateInputs) {
      document.getElementById('an-from').value = filter.from;
      document.getElementById('an-to').value = filter.to;
    }
    await loadAnalytics();
    render();
  },

  /** An empty workspace for a new product (the "New request" button). */
  newProduct() {
    ui.blank = true;
    ui.targetProductId = null;
    ui.feedback = null;
    if (ui.route !== 'home') location.hash = '#/';
    refresh();
  },

  /** Prepares a change request for a product and shows its latest request. */
  startChange(productId) {
    const product = state.products.find((p) => p.id === productId);
    if (!product) return;
    ui.targetProductId = productId;
    ui.blank = false;
    ui.feedback = null;
    ui.pinned = product.latestWorkflowId !== state.focusWorkflowId;
    ui.selectedId = product.latestWorkflowId;
    if (ui.route !== 'home') location.hash = '#/';
    refresh().then(() => {
      const input = document.getElementById('request-input');
      if (input) input.focus();
    });
  },

  setTarget(productId) {
    if (productId === '__answer') return;
    if (productId) actions.startChange(productId);
    else actions.newProduct();
  },

  async deleteProduct(productId) {
    const product = productId && state.products.find((p) => p.id === productId);
    const question = product
      ? `Delete "${product.title}" for good?\n\nThis removes its ${product.iterations} request(s), their conversation and activity, its statistics, and its files and Git history. This cannot be undone.`
      : `Delete ALL ${state.products.length} products for good?\n\nThis removes every request, all recorded activity and statistics, and all generated files. This cannot be undone.`;
    if (!window.confirm(question)) return;
    ui.deleting = productId || '*';
    render();
    try {
      await api(productId ? `/api/products/${productId}` : '/api/products?confirm=all', { method: 'DELETE' });
      if (!productId || (detail && detail.workflow.productId === productId)) ui.blank = true;
      if (!productId || ui.requirementsProductId === productId) {
        ui.requirementsProductId = null;
        ui.requirements = null;
      }
    } catch (error) {
      showError(`Could not delete: ${error.message}`);
    } finally {
      ui.deleting = null;
      await refresh();
    }
  },

  openRequirements(productId) {
    ui.requirementsProductId = productId;
    ui.requirements = null;
    if (ui.route !== 'requirements') location.hash = '#/requirements';
    else refresh();
  },

  select(workflowId) {
    ui.blank = false;
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

async function loadAnalytics() {
  try {
    ui.analytics = await api(analyticsQuery(ui.analyticsFilter));
    ui.analyticsError = null;
  } catch (error) {
    ui.analyticsError = error.message;
  }
}

async function loadRequirements() {
  if (!ui.requirementsProductId || !state.products.some((p) => p.id === ui.requirementsProductId)) {
    ui.requirementsProductId = (detail && detail.workflow.productId) || (state.products[0] && state.products[0].id) || null;
  }
  ui.requirements = ui.requirementsProductId ? await api(`/api/products/${ui.requirementsProductId}`) : null;
}

async function previewAction(path, body) {
  ui.previewBusy = true;
  render();
  try {
    const options = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method: 'POST' };
    return await api(path, options);
  } catch (error) {
    showError(`Live Preview: ${error.message}`);
    return null;
  } finally {
    ui.previewBusy = false;
    await refresh();
  }
}

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
          h('div', { className: 'view-head' }, h('div', null, h('h1', null, 'AI Scrum Team'), h('p', { className: 'muted' }, 'Three agents and you. Enable or disable an agent to change which work it can be assigned, and choose whether the PO and the Developer are scripted or AI-powered.'))),
          h('div', { id: 'ai-panel' }),
          h('div', { className: 'team-grid' }, h('div', { id: 'human-card' }), h('div', { id: 'agent-cards', className: 'agent-cards' })),
        ),
      );
      mountAiPanel(state, actions);
      break;
    case 'projects':
      mountProjects(actions);
      break;
    case 'requirements':
      mountRequirements(state, ui, actions);
      break;
    case 'activity':
      ws.mountSection('Team Activity', 'Everything recorded for the workflow shown in the project header, with evidence.', 'timeline', 'ol', 'timeline');
      break;
    case 'analytics':
      mountAnalytics(ui, actions);
      break;
    case 'repository':
      ws.mountSection('Repository', 'The generated product: files read from disk, test results and Git commits.', 'results', 'div', 'results');
      document.querySelector('.view-head').appendChild(
        h('button', { id: 'repo-delete', type: 'button', className: 'btn btn-sm btn-danger', onclick: () => detail && actions.deleteProduct(detail.workflow.productId) }, 'Delete this product'),
      );
      break;
    default:
      break;
  }
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
      ws.renderActivity(state, detail);
      break;
    case 'team':
      renderTeam(state, ui, actions);
      renderAiStatus(state, ui);
      break;
    case 'projects':
      renderProjects(state, ui, actions);
      break;
    case 'requirements':
      renderRequirements(state, ui, actions);
      break;
    case 'activity':
      renderTimeline(state, detail, ui);
      break;
    case 'repository':
      renderResults(state, detail, ui);
      document.getElementById('repo-delete').hidden = !detail;
      document.getElementById('repo-delete').disabled = ui.deleting !== null || (detail && detail.workflow.status === 'running');
      break;
    case 'analytics':
      renderAnalytics(ui.analytics, ui);
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
  if (ui.route === 'analytics' || ui.route === 'requirements') refresh();
  document.getElementById('view').focus({ preventScroll: true });
});

document.getElementById('new-request').addEventListener('click', () => {
  actions.newProduct();
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
  source.addEventListener('preview', scheduleRefresh);
}

setInterval(() => ws.renderElapsed(detail), 1000);
ui.route = routeFromHash();
refresh();
connect();

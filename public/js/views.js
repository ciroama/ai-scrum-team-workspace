// Rendering. Every view is a pure function of the server state, the
// selected workflow's detail and a little UI state. Nothing here invents
// progress: all content comes from recorded workflows, tasks and events.

import { bytes, dateTime, duration, h, icon, last, mount, time } from './dom.js';

const EXECUTION_LABEL = { idle: 'Idle', working: 'Working', waiting: 'Waiting', completed: 'Completed', failed: 'Failed' };
const CATEGORY_LABEL = {
  request: 'Requirement',
  analysis: 'Analysis',
  handoff: 'Handoff',
  implementation: 'Implementation',
  file: 'File',
  command: 'Command',
  test: 'Verification',
  defect: 'Defect',
  correction: 'Correction',
  review: 'Review',
  config: 'Configuration',
  git: 'Git',
  completion: 'Outcome',
  workflow: 'Workflow',
  error: 'Error',
};
const CATEGORY_ICON = { request: 'request', analysis: 'analysis', handoff: 'handoff', implementation: 'implementation', file: 'file', command: 'command', test: 'test', defect: 'defect', correction: 'correction', review: 'review', config: 'config', git: 'git', completion: 'completion', workflow: 'workflow', error: 'error' };

export function statusLabel(state, status) {
  return (state.statusLabels && state.statusLabels[status]) || status;
}

function agentLabel(state, id) {
  if (id === 'user') return 'You';
  const agent = state.agents.find((a) => a.id === id);
  return agent ? agent.label : 'System';
}

function kindBadge(kind) {
  if (kind === 'scripted') return h('span', { className: 'badge badge-scripted', title: 'Fixed rules and templates in code. No AI model.' }, 'Scripted');
  if (kind === 'ai') return h('span', { className: 'badge badge-ai' }, 'AI-powered');
  if (kind === 'human') return h('span', { className: 'badge badge-human' }, 'Human');
  return h('span', { className: 'badge badge-system', title: 'Workspace infrastructure, not a team member' }, 'System');
}

/** <details> whose open state survives re-rendering. */
function disclosure(ui, key, className, summary, body) {
  return h(
    'details',
    {
      className,
      open: ui.open.has(key),
      ontoggle: (e) => (e.target.open ? ui.open.add(key) : ui.open.delete(key)),
    },
    h('summary', null, summary),
    body,
  );
}

// ---- Header -------------------------------------------------------------------

export function renderHeader(state, detail) {
  const focus = state.workflows.find((w) => w.id === state.focusWorkflowId);
  const shown = detail ? detail.workflow : focus;
  mount('project-name', shown ? shown.title : 'No project yet');
  const pill = document.getElementById('overall-status');
  pill.dataset.status = focus ? focus.status : 'none';
  pill.textContent = focus ? `Workflow: ${statusLabel(state, focus.status)}` : 'No workflow';
}

// ---- Team -----------------------------------------------------------------------

export function renderTeam(state, ui, actions) {
  mount(
    'human-card',
    h(
      'article',
      { className: 'agent-card human' },
      h(
        'div',
        { className: 'agent-head' },
        h('div', { className: 'avatar avatar-user' }, icon('user')),
        h('div', { className: 'agent-id' }, h('div', { className: 'agent-name' }, 'You'), h('div', { className: 'agent-title' }, 'Product requester')),
        kindBadge('human'),
      ),
      h('p', { className: 'agent-summary' }, 'Submits requirements, gives direction and makes product decisions. Not an agent.'),
    ),
  );

  mount(
    'agent-cards',
    state.agents.map((agent) => {
      const pending = ui.pendingToggles.has(agent.id);
      return h(
        'article',
        { className: 'agent-card', dataset: { exec: agent.execution, enabled: String(agent.enabled) }, 'aria-label': `${agent.label} agent` },
        h(
          'div',
          { className: 'agent-head' },
          h('div', { className: `avatar avatar-${agent.id}` }, icon(agent.id)),
          h(
            'div',
            { className: 'agent-id' },
            h('div', { className: 'agent-name' }, agent.label),
            h('div', { className: 'agent-title' }, agent.title),
            kindBadge(agent.kind),
          ),
          h(
            'label',
            { className: 'switch', title: agent.enabled ? `Disable ${agent.label}` : `Enable ${agent.label}` },
            h('input', {
              type: 'checkbox',
              role: 'switch',
              checked: agent.enabled,
              disabled: pending,
              'aria-label': `${agent.label} available for assignments`,
              onchange: (e) => actions.toggleAgent(agent.id, e.target.checked),
            }),
            h('span', { className: 'track' }),
          ),
        ),
        h(
          'div',
          { className: 'state-row' },
          h(
            'span',
            { className: 'state availability', dataset: { value: agent.enabled ? 'enabled' : 'disabled' }, title: 'Availability (configuration)' },
            h('span', { className: 'state-label' }, 'Availability'),
            agent.enabled ? 'Enabled' : 'Disabled',
          ),
          h(
            'span',
            { className: 'state execution', dataset: { value: agent.execution }, title: 'Execution status' },
            h('span', { className: 'dot' }),
            EXECUTION_LABEL[agent.execution],
          ),
        ),
        agent.finishingTask &&
          h('p', { className: 'transition-note' }, `Disabled while working: "${agent.finishingTask}" will finish safely, then ${agent.label} receives no new assignments.`),
        h('p', { className: 'activity' }, agent.activity),
        h(
          'dl',
          { className: 'facts' },
          agent.lastOutcome && h('div', null, h('dt', null, 'Most recent outcome'), h('dd', null, agent.lastOutcome.summary)),
          agent.lastHandoff &&
            h('div', null, h('dt', null, `Last handoff · ${agent.lastHandoff.from} → ${agent.lastHandoff.to}`), h('dd', null, agent.lastHandoff.summary)),
        ),
        disclosure(ui, `resp-${agent.id}`, 'disclosure', 'Responsibilities', h('ul', null, agent.responsibilities.map((r) => h('li', null, r)))),
      );
    }),
  );
}

// ---- History ----------------------------------------------------------------------

export function renderHistory(state, ui, actions) {
  if (!state.workflows.length) {
    mount('history', h('li', { className: 'empty' }, 'No workflows yet.'));
    return;
  }
  mount(
    'history',
    state.workflows.map((wf) =>
      h(
        'li',
        null,
        h(
          'button',
          { type: 'button', 'aria-current': wf.id === ui.selectedId ? 'true' : 'false', onclick: () => actions.select(wf.id) },
          h(
            'span',
            null,
            h('span', { className: 'history-title' }, wf.title),
            h('span', { className: 'history-meta' }, `${dateTime(wf.createdAt)} · "${wf.requestText.slice(0, 48)}${wf.requestText.length > 48 ? '…' : ''}"`),
          ),
          h('span', { className: 'status-pill', dataset: { status: wf.status } }, statusLabel(state, wf.status)),
        ),
      ),
    ),
  );
}

// ---- Request ----------------------------------------------------------------------

export function renderRequest(state, ui, actions) {
  const active = state.workflows.find((w) => w.id === state.activeWorkflowId);
  const input = document.getElementById('request-input');
  const button = document.getElementById('start-button');
  const blockedBySlot = Boolean(active);
  input.disabled = ui.submitting;
  button.disabled = ui.submitting || blockedBySlot;
  button.textContent = ui.submitting ? 'Starting…' : 'Start workflow';

  mount(
    'supported',
    'Supported in this milestone: ',
    state.recipes.map((recipe, i) => [
      i > 0 ? ', ' : '',
      h('button', { type: 'button', className: 'link-button', title: recipe.summary, onclick: () => actions.fillRequest(recipe.examples[0]) }, recipe.title),
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

// ---- Progress ---------------------------------------------------------------------

function stageStates(state, detail) {
  const { workflow, tasks } = detail;
  const finished = !['running', 'blocked', 'interrupted'].includes(workflow.status);
  return state.stages.map((stage) => {
    const stageTasks = tasks.filter((t) => t.stage === stage.id);
    const lastTask = last(stageTasks);
    const attempts = stageTasks.length;
    let value = 'pending';
    let note = 'Not started';

    if (lastTask && lastTask.status === 'running') {
      value = 'active';
      note = 'In progress';
    } else if (workflow.stage === stage.id && workflow.status === 'blocked') {
      value = 'blocked';
      note = `Blocked: ${agentLabel(state, stage.agent)} disabled`;
    } else if (workflow.stage === stage.id && workflow.status === 'interrupted') {
      value = 'interrupted';
      note = 'Interrupted';
    } else if (lastTask && lastTask.status === 'completed') {
      const failedVerification = stage.id === 'verification' && lastTask.output && lastTask.output.verdict === 'fail';
      const rejected = stage.id === 'review' && lastTask.output && lastTask.output.accepted === false;
      value = failedVerification || rejected ? 'failed' : 'done';
      note = failedVerification ? 'Defects found' : rejected ? 'Not accepted' : 'Done';
    } else if (lastTask) {
      value = 'failed';
      note = lastTask.status === 'interrupted' ? 'Interrupted' : 'Error';
    } else if (workflow.stage === stage.id && workflow.status === 'running') {
      value = 'active';
      note = 'Starting';
    } else if (finished) {
      value = 'skipped';
      note = stage.id === 'correction' ? 'Not needed' : 'Not reached';
    } else if (stage.id === 'correction') {
      note = 'Only if QA finds defects';
    }
    if (attempts > 1) note += ` · ${attempts} rounds`;
    return { ...stage, value, note };
  });
}

function outcomeStep(state, workflow) {
  const map = {
    completed: ['done', workflow.verified ? 'Completed · verified' : 'Completed'],
    failed: ['failed', 'Failed'],
    needs_clarification: ['blocked', 'Needs clarification'],
    cancelled: ['skipped', 'Cancelled'],
    interrupted: ['interrupted', 'Interrupted'],
    blocked: ['blocked', 'Blocked'],
    running: ['pending', 'In progress'],
  };
  const [value, note] = map[workflow.status] || ['pending', statusLabel(state, workflow.status)];
  return { id: 'outcome', title: 'Outcome', agent: null, value, note };
}

const STEP_MARK = { done: '✓', failed: '✕', blocked: '!', interrupted: '!', active: '•', pending: '', skipped: '–' };

function verificationBadge(workflow) {
  if (workflow.verified) return h('span', { className: 'status-pill', dataset: { status: 'verified' } }, 'Verified by QA');
  const verification = workflow.state && workflow.state.verification;
  if (verification && verification.executed && verification.verdict === 'fail') {
    return h('span', { className: 'status-pill', dataset: { status: 'fail' } }, 'Verification failed');
  }
  if (['running'].includes(workflow.status)) return h('span', { className: 'status-pill', dataset: { status: 'none' } }, 'Verification pending');
  return h('span', { className: 'status-pill', dataset: { status: 'unverified' } }, 'Not verified');
}

export function renderProgress(state, detail, ui, actions) {
  if (!detail) {
    mount(
      'progress',
      h('div', { className: 'panel-head' }, h('h2', null, 'Workflow progress')),
      h('div', { className: 'empty' }, 'No workflow yet. Describe what you would like to build above and click "Start workflow" to see the team at work.'),
    );
    return;
  }
  const { workflow, tasks } = detail;
  const steps = stageStates(state, detail).concat(outcomeStep(state, workflow));
  const running = tasks.find((t) => t.status === 'running');
  const viewingOld = state.focusWorkflowId && workflow.id !== state.focusWorkflowId;

  let nowLine = null;
  if (running) nowLine = `Now: ${agentLabel(state, running.agentId)} — ${running.title.toLowerCase()}.`;
  else if (workflow.status === 'running') nowLine = 'Now: moving to the next stage…';

  mount(
    'progress',
    h(
      'div',
      { className: 'progress-head' },
      h('div', { className: 'progress-title' }, h('h2', null, workflow.title), h('span', { className: 'muted small mono' }, workflow.id)),
      h(
        'div',
        { className: 'progress-badges' },
        h('span', { className: 'status-pill', dataset: { status: workflow.status } }, statusLabel(state, workflow.status)),
        verificationBadge(workflow),
        viewingOld && h('button', { type: 'button', className: 'btn btn-sm btn-ghost', onclick: () => actions.select(null) }, 'Return to current workflow'),
      ),
    ),
    h('blockquote', { className: 'requirement-quote' }, `“${workflow.requestText}”`, h('span', { className: 'muted' }, `Submitted by you · ${dateTime(workflow.createdAt)}`)),
    h(
      'ol',
      { className: 'stepper', 'aria-label': 'Workflow stages' },
      steps.map((step) =>
        h(
          'li',
          { className: 'step', dataset: { state: step.value } },
          h('div', { className: 'step-top' }, h('span', { className: 'step-mark', 'aria-hidden': 'true' }, STEP_MARK[step.value]), step.title),
          h('div', { className: 'step-meta' }, (step.agent ? `${agentLabel(state, step.agent)} · ` : '') + step.note),
        ),
      ),
    ),
    nowLine && h('p', { className: 'now-line' }, nowLine),
    progressBanner(state, workflow, ui, actions),
  );
}

function progressBanner(state, workflow, ui, actions) {
  const busy = ui.pendingAction === workflow.id;
  if (workflow.status === 'blocked' || workflow.status === 'interrupted') {
    const stage = state.stages.find((s) => s.id === workflow.stage);
    const agent = state.agents.find((a) => a.id === stage.agent);
    const canResume = agent && agent.enabled;
    return h(
      'div',
      { className: 'banner', dataset: { tone: 'warning' } },
      h(
        'div',
        { className: 'banner-text' },
        h('strong', null, workflow.status === 'blocked' ? workflow.blockedReason : `Interrupted during ${stage.title}`),
        workflow.status === 'blocked'
          ? canResume
            ? `${agent.label} is enabled again. Click Resume to continue from ${stage.title}; earlier work is kept.`
            : `Enable ${agent.label} in the team panel, then click Resume to continue from ${stage.title}. Earlier work is kept.`
          : `The application stopped during this stage. Resume runs ${stage.title} again; earlier stages are kept.`,
      ),
      h(
        'div',
        { className: 'banner-actions' },
        h('button', { type: 'button', className: 'btn btn-primary btn-sm', disabled: !canResume || busy, onclick: () => actions.resume(workflow.id) }, 'Resume'),
        h('button', { type: 'button', className: 'btn btn-sm', disabled: busy, onclick: () => actions.cancel(workflow.id) }, 'Cancel workflow'),
      ),
    );
  }
  if (workflow.status === 'needs_clarification') {
    const clarification = workflow.state && workflow.state.clarification;
    return h(
      'div',
      { className: 'banner', dataset: { tone: 'warning' } },
      h('div', { className: 'banner-text' }, h('strong', null, 'The PO needs clarification'), clarification ? clarification.message : ''),
      h('div', { className: 'banner-actions' }, h('button', { type: 'button', className: 'btn btn-sm', onclick: () => actions.fillRequest(workflow.requestText) }, 'Edit request')),
    );
  }
  if (workflow.status === 'failed') {
    return h(
      'div',
      { className: 'banner', dataset: { tone: 'danger' } },
      h('div', { className: 'banner-text' }, h('strong', null, 'Workflow failed'), workflow.error || (workflow.state && workflow.state.review && workflow.state.review.summary) || 'See the activity timeline for details.'),
    );
  }
  return null;
}

// ---- Timeline -----------------------------------------------------------------------

function evidenceFor(event, state) {
  const d = event.detail || {};
  switch (event.type) {
    case 'workflow.created':
      return h('ul', null, (d.team || []).map((a) => h('li', null, `${a.label}: ${a.enabled ? 'enabled' : 'disabled'} (${a.kind})`)));
    case 'po.requirements':
      return [
        h('strong', null, 'Requirements'),
        h('ol', null, d.requirements.map((r) => h('li', null, r))),
        h('strong', null, 'Acceptance criteria'),
        h('ul', null, d.acceptanceCriteria.map((c) => h('li', null, h('strong', null, `${c.id}: `), c.description))),
      ];
    case 'po.clarification':
      return [h('strong', null, 'Supported request types'), h('ul', null, (d.supported || []).map((r) => h('li', null, `${r.title} — ${r.summary}`)))];
    case 'file.written':
      return h('dl', { className: 'kv' }, h('dt', null, 'Path'), h('dd', { className: 'mono' }, d.path), h('dt', null, 'Change'), h('dd', null, d.change), h('dt', null, 'Size'), h('dd', null, bytes(d.bytes)), h('dt', null, 'SHA-256'), h('dd', { className: 'mono' }, d.sha256.slice(0, 16) + '…'));
    case 'dev.implementation':
    case 'dev.correction':
      return h('table', { className: 'data' }, h('thead', null, h('tr', null, h('th', null, 'File'), h('th', null, 'Change'), h('th', null, 'Size'))), h('tbody', null, d.files.map((f) => h('tr', null, h('td', { className: 'mono' }, f.path), h('td', null, f.change), h('td', { className: 'num' }, bytes(f.bytes))))));
    case 'qa.plan':
      return h('ul', null, d.commands.map((c) => h('li', null, `${c.label}: `, h('code', null, c.command))));
    case 'qa.files':
      return [h('div', null, `Required: ${d.required.join(', ')}`), d.missing.length ? h('div', { className: 'result-fail' }, `Missing: ${d.missing.join(', ')}`) : null];
    case 'command.finished':
      return [
        h('dl', { className: 'kv' }, h('dt', null, 'Command'), h('dd', { className: 'mono' }, d.command), h('dt', null, 'Exit code'), h('dd', null, String(d.exitCode)), h('dt', null, 'Duration'), h('dd', null, duration(d.durationMs))),
        d.stdout ? h('pre', { className: 'output' }, d.stdout) : null,
        d.stderr ? h('pre', { className: 'output' }, d.stderr) : null,
      ];
    case 'test.results':
      return testTable(d.tests);
    case 'qa.verdict':
      return criteriaList(d.criteria);
    case 'defect.reported':
      return [
        h('dl', { className: 'kv' }, d.expected != null ? [h('dt', null, 'Expected'), h('dd', null, String(d.expected))] : null, d.actual != null ? [h('dt', null, 'Actual'), h('dd', null, String(d.actual))] : null),
        d.evidence ? h('pre', { className: 'output' }, d.evidence) : null,
      ];
    case 'git.commit':
      return h('dl', { className: 'kv' }, h('dt', null, 'Commit'), h('dd', { className: 'mono' }, d.commit), h('dt', null, 'Files'), h('dd', { className: 'mono' }, d.files.join(', ')), h('dt', null, 'Repository'), h('dd', { className: 'mono' }, d.repository));
    case 'handoff':
      if (d.defects) return h('ul', null, d.defects.map((t) => h('li', null, t)));
      if (d.references) return h('div', null, 'References: ', h('span', { className: 'mono' }, d.references.join(', ')), d.commit ? ` · commit ${d.commit.slice(0, 7)}` : '');
      return null;
    default:
      return event.error ? h('pre', { className: 'output' }, event.error) : null;
  }
}

function testTable(tests) {
  return h(
    'table',
    { className: 'data' },
    h('thead', null, h('tr', null, h('th', null, 'Test'), h('th', null, 'Result'), h('th', null, 'Duration'))),
    h(
      'tbody',
      null,
      tests.map((t) =>
        h(
          'tr',
          null,
          h('td', null, t.name, t.status === 'fail' && t.error ? h('pre', { className: 'output' }, t.error) : null),
          h('td', { className: t.status === 'pass' ? 'result-pass' : 'result-fail' }, t.status === 'pass' ? 'Passed' : t.status === 'fail' ? 'Failed' : t.status),
          h('td', { className: 'num' }, duration(t.durationMs)),
        ),
      ),
    ),
  );
}

function criteriaList(criteria) {
  return h(
    'ul',
    { className: 'criteria' },
    criteria.map((c) =>
      h(
        'li',
        null,
        h('span', { className: `mark ${c.status === 'pass' ? 'result-pass' : c.status === 'fail' ? 'result-fail' : 'muted'}` }, c.status === 'pass' ? '✓' : c.status === 'fail' ? '✕' : '○'),
        h('span', null, h('strong', null, `${c.id}: `), c.description, c.evidence ? h('div', { className: 'muted small' }, c.evidence) : null),
      ),
    ),
  );
}

function timelineEvent(event, state, ui) {
  const isHandoff = event.type === 'handoff';
  const actorBlock = isHandoff
    ? [h('span', { className: 'actor' }, agentLabel(state, event.from)), h('span', { className: 'arrow', 'aria-label': 'to' }, '→'), h('span', { className: 'actor' }, agentLabel(state, event.to))]
    : event.type === 'po.clarification'
      ? [h('span', { className: 'actor' }, 'PO'), h('span', { className: 'arrow', 'aria-label': 'to' }, '→'), h('span', { className: 'actor' }, 'You')]
      : [h('span', { className: 'actor' }, agentLabel(state, event.actor))];
  const evidence = evidenceFor(event, state);
  return h(
    'li',
    { className: `event cat-${event.category}${isHandoff ? ' is-handoff' : ''}`, dataset: { status: event.status } },
    h('div', { className: 'event-icon' }, icon(CATEGORY_ICON[event.category] || 'system')),
    h(
      'div',
      { className: 'event-body' },
      h(
        'div',
        { className: 'event-head' },
        actorBlock,
        kindBadge(event.actorKind),
        h('span', { className: 'event-cat' }, CATEGORY_LABEL[event.category] || event.category),
        h('time', { className: 'event-time', datetime: event.ts }, time(event.ts)),
      ),
      h('p', { className: 'event-summary' }, event.summary),
      evidence && disclosure(ui, `ev-${event.id}`, 'evidence', 'Evidence', h('div', { className: 'evidence-body' }, evidence)),
    ),
  );
}

export function renderTimeline(state, detail, ui) {
  const list = document.getElementById('timeline');
  const events = detail ? detail.events : state.workspaceEvents;
  if (!events.length) {
    mount(list, h('li', { className: 'empty' }, detail ? 'Waiting for the first event…' : 'No activity yet. Events appear here as the team works.'));
    return;
  }
  // A finished command already shows its command line; hide the matching start event.
  const finished = new Set(events.filter((e) => e.type === 'command.finished').map((e) => `${e.taskId}|${e.detail.command}`));
  const visible = events.filter((e) => !(e.type === 'command.started' && finished.has(`${e.taskId}|${e.detail.command}`)));
  const seen = ui.renderedEvents;
  mount(
    list,
    visible.map((event) => {
      const node = timelineEvent(event, state, ui);
      if (seen.has(event.id)) node.style.animation = 'none';
      seen.add(event.id);
      return node;
    }),
  );
}

// ---- Results ----------------------------------------------------------------------

function outcomeCard(state, detail) {
  const { workflow, events } = detail;
  const st = workflow.state || {};
  const tests = st.verification && st.verification.testSummary;
  let tone = 'neutral';
  let title = statusLabel(state, workflow.status);
  let text;

  switch (workflow.status) {
    case 'completed':
      tone = 'success';
      title = workflow.verified ? 'Built and verified' : 'Completed';
      text =
        `"${workflow.title}" was built by the Developer and verified by QA: ${st.verification.criteria.length} of ` +
        `${st.verification.criteria.length} acceptance criteria met and ${tests.pass} of ${tests.tests} automated tests passed. ` +
        (st.review ? 'The PO accepted the result.' : '');
      break;
    case 'failed':
      tone = 'danger';
      title = 'Not delivered';
      text = workflow.error ? `The workflow stopped because of an error: ${workflow.error}` : st.review ? st.review.summary : 'See the timeline for details.';
      break;
    case 'blocked':
      tone = 'warning';
      title = 'Blocked — not verified';
      text = `${workflow.blockedReason} Nothing after this point has been done, and the result is not verified.`;
      break;
    case 'needs_clarification':
      tone = 'warning';
      title = 'Waiting for a clearer request';
      text = st.clarification ? st.clarification.message : 'The PO needs clarification.';
      break;
    case 'interrupted':
      tone = 'warning';
      title = 'Interrupted — not verified';
      text = 'The application stopped while this workflow was running. Resume it or cancel it.';
      break;
    case 'cancelled':
      title = 'Cancelled';
      text = `You cancelled this workflow. It was ${workflow.verified ? '' : 'not completed or '}verified.`;
      break;
    default:
      title = 'In progress';
      text = 'The team is working on it. Results appear here as they are produced.';
  }
  const completedEvent = events.find((e) => e.type === 'workflow.completed' || e.type === 'workflow.failed');
  return h(
    'div',
    { className: 'outcome', dataset: { tone } },
    h('div', { className: 'outcome-head' }, h('span', { className: 'outcome-title' }, title), verificationBadge(workflow)),
    h('p', null, text),
    completedEvent ? h('p', { className: 'muted small' }, `Finished ${dateTime(completedEvent.ts)} · took ${duration(new Date(completedEvent.ts) - new Date(workflow.createdAt))}`) : null,
  );
}

export function renderResults(state, detail, ui) {
  if (!detail) {
    mount('results', h('div', { className: 'empty' }, 'Results, generated files, test results and Git commits appear here once a workflow runs.'));
    return;
  }
  const { workflow, events, product } = detail;
  const st = workflow.state || {};
  const testEvent = last(events.filter((e) => e.type === 'test.results'));
  const commits = events.filter((e) => e.type === 'git.commit');
  const gitProblem = last(events.filter((e) => e.type === 'git.unavailable' || e.type === 'git.failed'));
  const criteria = st.verification
    ? st.verification.criteria
    : st.spec
      ? st.spec.acceptanceCriteria.map((c) => ({ id: c.id, description: c.description, status: 'pending', evidence: 'Not verified yet' }))
      : null;

  const issues = [];
  if (workflow.blockedReason && workflow.status === 'blocked') issues.push(workflow.blockedReason);
  if (workflow.error) issues.push(`Error: ${workflow.error}`);
  if (st.verification && st.verification.verdict === 'fail') st.verification.defects.forEach((d) => issues.push(`Open defect: ${d.title}`));
  if (gitProblem) issues.push(gitProblem.summary);
  if (st.spec && !st.verification && workflow.status !== 'running') issues.push('QA has not verified this implementation.');

  mount(
    'results',
    h(
      'div',
      { className: 'results' },
      h('section', null, outcomeCard(state, detail)),
      criteria && h('section', null, h('h3', null, 'Acceptance criteria'), criteriaList(criteria)),
      testEvent &&
        h(
          'section',
          null,
          h('h3', null, 'Latest test run'),
          h(
            'div',
            { className: 'stat-row' },
            h('div', { className: 'stat' }, h('strong', null, testEvent.detail.summary.tests ?? 0), h('span', null, 'tests')),
            h('div', { className: 'stat' }, h('strong', { className: 'result-pass' }, testEvent.detail.summary.pass ?? 0), h('span', null, 'passed')),
            h('div', { className: 'stat' }, h('strong', { className: testEvent.detail.summary.fail ? 'result-fail' : '' }, testEvent.detail.summary.fail ?? 0), h('span', null, 'failed')),
            h('div', { className: 'stat' }, h('strong', null, duration(testEvent.detail.summary.duration_ms)), h('span', null, 'runner time')),
          ),
          disclosure(ui, `tests-${testEvent.id}`, 'disclosure', 'Show individual tests', testTable(testEvent.detail.tests)),
        ),
      h('section', null, h('h3', null, 'Outstanding issues'), issues.length ? h('ul', { className: 'issues' }, issues.map((i) => h('li', null, i))) : h('p', { className: 'muted small' }, 'None recorded.')),
      h(
        'section',
        null,
        h('h3', null, `Generated files (${product.files.length})`),
        product.files.length
          ? [
              h('p', { className: 'muted small' }, 'The product is separate from this dashboard. Its files are read from disk:'),
              h('div', { className: 'path-box' }, product.root),
              h(
                'ul',
                { className: 'file-list' },
                product.files.map((f) =>
                  h('li', null, disclosure(ui, `file-${workflow.id}-${f.path}`, '', [icon('file'), h('span', { className: 'file-path' }, f.path), h('span', { className: 'file-size' }, bytes(f.bytes))], f.content == null ? h('p', { className: 'muted small' }, 'File too large to preview.') : h('pre', { className: 'output' }, f.content))),
                ),
              ),
            ]
          : h('p', { className: 'muted small' }, 'No files have been generated for this workflow.'),
      ),
      h(
        'section',
        null,
        h('h3', null, 'Product Git repository'),
        commits.length
          ? [
              h('p', { className: 'muted small' }, 'Local repository inside the product folder. Nothing is pushed to GitHub.'),
              h('ul', { className: 'commit-list' }, commits.map((c) => h('li', null, h('span', { className: 'commit-hash' }, c.detail.commit.slice(0, 7)), h('span', null, c.detail.message)))),
            ]
          : gitProblem
            ? h('p', { className: 'small' }, gitProblem.summary)
            : h('p', { className: 'muted small' }, state.git.available ? 'No commits yet.' : `Git is not available: ${state.git.reason}`),
      ),
    ),
  );
}

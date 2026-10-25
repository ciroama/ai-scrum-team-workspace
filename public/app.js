// Dashboard client. Plain browser JavaScript (no build step), kept to
// features available in Safari 16 and Chrome on macOS 11.
(function () {
  'use strict';

  var state = {
    workspace: null,
    team: [],
    stories: [],
    runs: [],
    runModes: {},
    selectedRunId: null,
    events: [], // events of the selected run, ordered by seq
    files: [],
    selectedFile: null,
    fileChosenByUser: false,
  };

  // ---- helpers -------------------------------------------------------------

  /** Creates an element. Children may be strings (inserted as text) or nodes. */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value == null || value === false) return;
      if (key === 'className') el.className = value;
      else if (key.indexOf('on') === 0) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }

  function append(el, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) child.forEach(function (c) { append(el, c); });
    else el.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }

  function mount(id) {
    var el = document.getElementById(id);
    el.textContent = '';
    for (var i = 1; i < arguments.length; i++) append(el, arguments[i]);
  }

  function api(path, options) {
    return fetch(path, options).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body.error || res.statusText);
        return body;
      });
    });
  }

  function statusPill(status) {
    return h('span', { className: 'status status-' + status }, String(status).replace('_', ' '));
  }

  function kindBadge(kind) {
    if (kind === 'scripted') return h('span', { className: 'badge badge-scripted', title: 'Rules and templates in code. No AI model.' }, 'Scripted');
    if (kind === 'ai') return h('span', { className: 'badge badge-ai', title: 'Model-backed agent' }, 'AI-powered');
    return h('span', { className: 'badge badge-system', title: 'Recorded by the platform itself' }, 'System');
  }

  function time(iso) {
    return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  }

  function ms(value) {
    return value == null ? '—' : value < 1000 ? value.toFixed(1) + ' ms' : (value / 1000).toFixed(2) + ' s';
  }

  function agentName(id) {
    var agent = state.team.find(function (a) { return a.id === id; });
    return agent ? agent.name : 'Platform';
  }

  function selectedRun() {
    return state.runs.find(function (r) { return r.id === state.selectedRunId; }) || null;
  }

  function eventsOfType(type) {
    return state.events.filter(function (e) { return e.type === type; });
  }

  // ---- data loading ----------------------------------------------------------

  function loadState() {
    return api('/api/state').then(function (data) {
      state.workspace = data.workspace;
      state.team = data.team;
      state.stories = data.stories;
      state.runs = data.runs;
      state.runModes = data.runModes;
      if (!state.selectedRunId && state.runs.length) return selectRun(state.runs[0].id);
      render();
    });
  }

  function selectRun(runId) {
    state.selectedRunId = runId;
    state.events = [];
    state.files = [];
    state.selectedFile = null;
    state.fileChosenByUser = false;
    render();
    return Promise.all([
      api('/api/runs/' + runId).then(function (data) {
        if (state.selectedRunId !== runId) return;
        mergeEvents(data.events);
      }),
      loadFiles(runId),
    ]).then(render);
  }

  function loadFiles(runId) {
    return api('/api/runs/' + runId + '/files').then(function (data) {
      if (state.selectedRunId !== runId) return;
      state.files = data.files;
      var stillThere = data.files.some(function (f) { return f.path === state.selectedFile; });
      if (!state.fileChosenByUser || !stillThere) {
        var preferred = data.files.find(function (f) { return f.path === 'hello.js'; });
        state.selectedFile = preferred ? preferred.path : data.files.length ? data.files[0].path : null;
      }
    });
  }

  function mergeEvents(events) {
    var known = {};
    state.events.forEach(function (e) { known[e.seq] = true; });
    events.forEach(function (e) { if (!known[e.seq]) state.events.push(e); });
    state.events.sort(function (a, b) { return a.seq - b.seq; });
  }

  function startRun(storyId, mode) {
    return api('/api/stories/' + storyId + '/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: mode }),
    })
      .then(function (data) {
        state.runs.unshift(data.run);
        return selectRun(data.run.id);
      })
      .catch(function (error) { alert('Could not start the run: ' + error.message); });
  }

  // ---- live updates ------------------------------------------------------------

  var refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadState, 150);
  }

  var filesTimer = null;
  function scheduleFiles(runId) {
    clearTimeout(filesTimer);
    filesTimer = setTimeout(function () { loadFiles(runId).then(render); }, 150);
  }

  function connect() {
    var connection = document.getElementById('connection');
    function setConnection(value, label) {
      connection.setAttribute('data-state', value);
      connection.querySelector('.label').textContent = label;
    }
    var source = new EventSource('/api/stream');
    source.onopen = function () {
      setConnection('live', 'Live');
      loadState();
    };
    source.onerror = function () { setConnection('offline', 'Reconnecting…'); };
    source.addEventListener('execution', function (message) {
      var event = JSON.parse(message.data);
      if (event.runId !== state.selectedRunId) return;
      mergeEvents([event]);
      if (event.type === 'file.written' || event.type === 'run.completed') scheduleFiles(event.runId);
      render();
    });
    source.addEventListener('change', scheduleRefresh);
  }

  // ---- rendering ---------------------------------------------------------------

  function activeAgentId() {
    var run = selectedRun();
    if (!run || run.status !== 'running') return null;
    var started = eventsOfType('step.started');
    var last = started[started.length - 1];
    if (!last) return null;
    var finished = eventsOfType('step.completed').some(function (e) { return e.step === last.step; });
    return finished ? null : last.agentId;
  }

  function renderTeam() {
    var active = activeAgentId();
    mount(
      'team',
      h(
        'div',
        { className: 'agent agent-human' },
        h('div', { className: 'agent-head' }, h('span', { className: 'agent-name' }, 'You'), h('span', { className: 'badge badge-human' }, 'Human')),
        h('div', { className: 'agent-role' }, 'Stakeholder'),
        h('div', { className: 'agent-summary' }, 'Requests and guides the product: starts runs and reviews the results.'),
      ),
      state.team.map(function (agent) {
        var isActive = agent.id === active;
        return h(
          'div',
          { className: 'agent', 'data-active': isActive ? 'true' : 'false' },
          h('div', { className: 'agent-head' }, h('span', { className: 'agent-name' }, agent.name), kindBadge(agent.kind)),
          h('div', { className: 'agent-role' }, agent.role),
          h('div', { className: 'agent-summary' }, agent.summary),
          h('div', { className: 'agent-status' }, isActive ? 'Working on the current step…' : 'Idle'),
        );
      }),
    );
  }

  function renderBacklog() {
    var busy = state.runs.some(function (r) { return r.status === 'running'; });
    mount(
      'backlog',
      state.stories.map(function (story) {
        return h(
          'div',
          { className: 'story' },
          h('div', null, h('span', { className: 'story-title' }, story.title), statusPill(story.status)),
          h('p', null, story.description),
          story.acceptance
            ? h('ul', null, story.acceptance.map(function (c) { return h('li', null, h('strong', null, c.id + ': '), c.description); }))
            : h('p', null, 'Acceptance criteria are written by the PO during the first run.'),
          h(
            'div',
            { className: 'actions' },
            h('button', { onclick: function () { startRun(story.id, 'standard'); }, disabled: busy }, 'Run workflow'),
            h(
              'button',
              { className: 'secondary', onclick: function () { startRun(story.id, 'faulty'); }, disabled: busy, title: state.runModes.faulty },
              'Run with injected defect',
            ),
          ),
        );
      }),
    );
  }

  function renderHistory() {
    if (!state.runs.length) return mount('history', h('li', { className: 'empty' }, 'No runs yet.'));
    mount(
      'history',
      state.runs.map(function (run) {
        return h(
          'li',
          { onclick: function () { selectRun(run.id); }, 'aria-current': run.id === state.selectedRunId ? 'true' : 'false' },
          h('span', null, time(run.startedAt) + ' · ' + run.mode),
          statusPill(run.status),
        );
      }),
    );
  }

  function renderRun() {
    var run = selectedRun();
    if (!run) {
      mount('run-header', h('div', null, h('h2', null, 'No run selected'), h('p', { className: 'hint' }, 'Start the Hello World workflow from the backlog.')));
      mount('steps');
      return;
    }
    var duration = run.finishedAt ? ms(new Date(run.finishedAt) - new Date(run.startedAt)) : 'running…';
    mount(
      'run-header',
      h('div', null, h('h2', null, 'Run ' + run.id), h('div', { className: 'run-meta' }, 'Mode: ' + run.mode + ' · started ' + time(run.startedAt) + ' · duration ' + duration)),
      statusPill(run.status),
    );

    var started = eventsOfType('run.started')[0];
    var steps = started ? started.payload.steps : [];
    var failed = eventsOfType('run.error').length > 0;
    mount(
      'steps',
      steps.map(function (step, index) {
        var begun = state.events.some(function (e) { return e.type === 'step.started' && e.step === step.id; });
        var done = state.events.some(function (e) { return e.type === 'step.completed' && e.step === step.id; });
        var stepState = done ? 'done' : begun ? (failed ? 'error' : 'active') : 'pending';
        return h(
          'li',
          { className: 'step', 'data-state': stepState },
          h('div', { className: 'step-title' }, index + 1 + '. ' + step.title),
          h('div', { className: 'run-meta' }, agentName(step.agent) + ' · ' + stepState),
        );
      }),
    );
  }

  function describe(event) {
    var p = event.payload;
    switch (event.type) {
      case 'run.started': return 'Workflow "' + p.workflow + '" started for "' + p.storyTitle + '" (' + p.mode + ' mode)';
      case 'story.updated': return 'Story status → ' + p.status;
      case 'step.started': return 'Step started: ' + p.title;
      case 'step.completed': return 'Step completed: ' + p.title;
      case 'agent.message': return p.text;
      case 'file.written': return p.path + ' (' + p.bytes + ' bytes, sha256 ' + p.sha256.slice(0, 12) + '…) — ' + p.purpose;
      case 'command.started': return '$ ' + p.command + ' ' + p.args.join(' ');
      case 'command.exited': return 'Exit code ' + p.exitCode + (p.timedOut ? ' (timed out)' : '') + ' after ' + ms(p.durationMs);
      case 'test.result': return (p.status === 'pass' ? '✓ ' : '✗ ') + p.name + ' (' + ms(p.durationMs) + ')';
      case 'test.summary': return p.tests + ' tests · ' + p.pass + ' passed · ' + p.fail + ' failed';
      case 'run.completed': return 'Run finished: ' + p.status;
      case 'run.error': return 'Run error: ' + p.message;
      default: return JSON.stringify(p);
    }
  }

  function renderTimeline() {
    var shown = state.events.filter(function (e) { return e.type !== 'command.output'; });
    if (!shown.length) return mount('timeline', h('li', { className: 'empty' }, 'No events yet.'));
    var list = document.getElementById('timeline');
    var atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 20;
    mount(
      'timeline',
      shown.map(function (event) {
        return h(
          'li',
          null,
          h('span', { className: 'seq' }, '#' + event.seq),
          h('span', { className: 'time' }, time(event.ts)),
          h(
            'span',
            null,
            h('span', { className: 'type' }, event.type),
            event.agentId ? [agentName(event.agentId) + ' ', kindBadge(event.agentKind)] : kindBadge(null),
            h('span', { className: 'text' }, describe(event)),
          ),
        );
      }),
    );
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  function renderTests() {
    var results = eventsOfType('test.result');
    var summary = eventsOfType('test.summary')[0];
    if (!results.length && !summary) return mount('tests', h('p', { className: 'empty' }, 'No test results for this run yet.'));
    var p = summary ? summary.payload : {};
    mount(
      'tests',
      summary &&
        h(
          'div',
          { className: 'test-summary' },
          h('div', null, h('strong', null, p.tests), 'tests'),
          h('div', { className: 'status-pass' }, h('strong', null, p.pass), 'passed'),
          h('div', { className: p.fail ? 'status-fail' : '' }, h('strong', null, p.fail), 'failed'),
          h('div', null, h('strong', null, ms(p.duration_ms)), 'runner time'),
          h('div', null, 'exit code ', h('strong', null, p.exitCode)),
        ),
      h(
        'table',
        null,
        h('thead', null, h('tr', null, h('th', null, 'Test'), h('th', null, 'Result'), h('th', null, 'Duration'))),
        h(
          'tbody',
          null,
          results.map(function (e) {
            var t = e.payload;
            return h(
              'tr',
              null,
              h('td', null, t.name, t.status === 'fail' ? h('pre', { className: 'failure' }, t.error) : null),
              h('td', null, statusPill(t.status)),
              h('td', { className: 'num' }, ms(t.durationMs)),
            );
          }),
        ),
      ),
    );
  }

  function renderFiles() {
    if (!state.files.length) return mount('files', h('p', { className: 'empty' }, 'No files in this run workspace yet.'));
    var current = state.files.find(function (f) { return f.path === state.selectedFile; }) || state.files[0];
    mount(
      'files',
      h(
        'div',
        { className: 'file-tabs' },
        state.files.map(function (file) {
          return h(
            'button',
            {
              'aria-pressed': file.path === current.path ? 'true' : 'false',
              onclick: function () {
                state.selectedFile = file.path;
                state.fileChosenByUser = true;
                renderFiles();
              },
            },
            file.path + ' · ' + file.bytes + ' B',
          );
        }),
      ),
      h('pre', { className: 'code' }, current.content),
    );
  }

  function renderTerminal() {
    var lines = state.events.filter(function (e) { return e.type.indexOf('command.') === 0; });
    if (!lines.length) return mount('terminal', 'No commands run yet.');
    mount(
      'terminal',
      lines.map(function (e) {
        if (e.type === 'command.started') return h('span', { className: 'meta' }, '$ ' + e.payload.command + ' ' + e.payload.args.join(' ') + '   (cwd: ' + e.payload.cwd + ')\n');
        if (e.type === 'command.exited') return h('span', { className: 'meta' }, '[exit code ' + e.payload.exitCode + ', ' + ms(e.payload.durationMs) + ']\n');
        return h('span', { className: e.payload.stream }, e.payload.line + '\n');
      }),
    );
  }

  function render() {
    renderTeam();
    renderBacklog();
    renderHistory();
    renderRun();
    renderTimeline();
    renderTests();
    renderFiles();
    renderTerminal();
  }

  loadState().catch(function (error) { console.error(error); });
  connect();
})();

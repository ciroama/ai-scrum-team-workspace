// AI provider settings (Claude Code), shown on the Team page.
// The form is built once per visit so typing is never interrupted by live
// updates; only the status line is re-rendered.

import { dateTime, h, icon, mount } from './dom.js';

export function mountAiPanel(state, actions) {
  const ai = state.ai;
  const model = h('input', { id: 'ai-model', type: 'text', spellcheck: 'false', value: ai.model, placeholder: ai.defaultModel, list: 'ai-models' });

  mount(
    'ai-panel',
    h(
      'section',
      { className: 'chart-panel ai-panel', 'aria-labelledby': 'ai-heading' },
      h('div', { className: 'kpi-head' }, h('h2', { id: 'ai-heading', className: 'with-icon' }, icon('ai'), `AI provider: ${ai.providerName}`), h('span', { id: 'ai-status-chip', className: 'chip' })),
      h(
        'p',
        { className: 'muted small' },
        'Uses Claude Code installed on this computer, with its own login (for example a Claude Pro subscription). No API key is stored here. ',
        'Set an agent\'s Brain to "AI-powered" below to use it, and pick its model there if it should differ from the default. Requests and the generated files are sent to Anthropic over the internet.',
      ),
      h(
        'form',
        {
          className: 'ai-form',
          onsubmit: (e) => {
            e.preventDefault();
            actions.saveAi({ model: model.value.trim() });
          },
        },
        h('label', null, h('span', null, 'Default model for every AI-powered agent (sonnet uses less of the subscription limit than opus; haiku uses the least)'), model),
        h('datalist', { id: 'ai-models' }, ai.suggestedModels.map((m) => h('option', { value: m }))),
        h(
          'div',
          { className: 'ai-actions' },
          h('button', { type: 'submit', className: 'btn btn-primary btn-sm' }, 'Save'),
          h('button', { type: 'button', className: 'btn btn-sm', onclick: () => actions.testAi() }, 'Test connection'),
        ),
      ),
      h('div', { id: 'ai-status', className: 'ai-status', role: 'status', 'aria-live': 'polite' }),
      h(
        'details',
        { className: 'disclosure' },
        h('summary', null, 'How to set up Claude Code'),
        h(
          'ol',
          null,
          h('li', null, 'Install Claude Code on the computer that runs this workspace: ', h('span', { className: 'mono' }, 'curl -fsSL https://claude.ai/install.sh | bash'), '.'),
          h('li', null, 'Run ', h('span', { className: 'mono' }, 'claude'), ' once in a terminal and log in with your Claude account (subscription).'),
          h('li', null, 'Click "Test connection" above. It sends one small real request.'),
        ),
      ),
    ),
  );
}

export function renderAiStatus(state, ui) {
  const ai = state.ai;
  const chip = document.getElementById('ai-status-chip');
  if (!chip) return;
  let tone = 'info';
  let label = 'Not tested yet';
  if (ai.lastCheck) [tone, label] = ai.lastCheck.ok ? ['success', 'Connected'] : ['danger', 'Connection failed'];
  chip.dataset.tone = tone;
  mount(chip, h('span', { className: 'dot' }), label);

  const usedBy = state.agents.filter((a) => a.mode === 'ai').map((a) => a.label);
  mount(
    'ai-status',
    ui.aiMessage ? h('p', { className: 'feedback', dataset: { tone: ui.aiMessage.tone } }, ui.aiMessage.text) : null,
    h(
      'p',
      { className: 'muted small' },
      `Model: ${ai.model}. `,
      usedBy.length ? `AI-powered now: ${usedBy.join(', ')}.` : 'No agent is AI-powered yet.',
      ai.lastCheck ? ` Last test ${dateTime(ai.lastCheck.at)}: ${ai.lastCheck.message}` : '',
    ),
  );
}

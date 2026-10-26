// AI provider settings (GitHub Models), shown on the Team page.
// The form is built once per visit so typing is never interrupted by live
// updates; only the status line is re-rendered.

import { dateTime, h, icon, mount } from './dom.js';

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

export function mountAiPanel(state, actions) {
  const ai = state.ai;
  const token = h('input', {
    id: 'ai-token',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: ai.tokenConfigured ? `Token saved (${ai.tokenHint}). Paste a new one to replace it.` : 'Paste your GitHub token (github_pat_…)',
  });
  const model = h('input', { id: 'ai-model', type: 'text', spellcheck: 'false', value: ai.model, placeholder: ai.defaultModel });

  mount(
    'ai-panel',
    h(
      'section',
      { className: 'chart-panel ai-panel', 'aria-labelledby': 'ai-heading' },
      h('div', { className: 'kpi-head' }, h('h2', { id: 'ai-heading', className: 'with-icon' }, icon('ai'), `AI provider: ${ai.providerName}`), h('span', { id: 'ai-status-chip', className: 'chip' })),
      h(
        'p',
        { className: 'muted small' },
        'Free, rate-limited AI models for every GitHub account. Set the PO and the Developer to "AI-powered" below to use it. ',
        'When they are AI-powered, your request text and the generated files are sent to GitHub Models over the internet. QA always stays scripted.',
      ),
      h(
        'form',
        {
          className: 'ai-form',
          onsubmit: (e) => {
            e.preventDefault();
            actions.saveAi({ token: token.value.trim() || undefined, model: model.value.trim() });
            token.value = '';
          },
        },
        h('label', null, h('span', null, 'GitHub token (permission "Models: read")'), token),
        h('label', null, h('span', null, 'Model'), model),
        h(
          'div',
          { className: 'ai-actions' },
          h('button', { type: 'submit', className: 'btn btn-primary btn-sm' }, 'Save'),
          h('button', { type: 'button', className: 'btn btn-sm', onclick: () => actions.testAi() }, 'Test connection'),
          h('button', { type: 'button', className: 'btn btn-sm btn-ghost', onclick: () => actions.saveAi({ token: '' }) }, 'Remove token'),
        ),
      ),
      h('div', { id: 'ai-status', className: 'ai-status', role: 'status', 'aria-live': 'polite' }),
      h(
        'details',
        { className: 'disclosure' },
        h('summary', null, 'How to create the token'),
        h(
          'ol',
          null,
          h('li', null, 'Open ', h('a', { className: 'link-button', href: TOKEN_URL, target: '_blank', rel: 'noopener' }, 'github.com/settings/personal-access-tokens/new'), '.'),
          h('li', null, 'Give it a name, choose an expiration, and under "Permissions" add "Models" with access "Read-only". No repository access is needed.'),
          h('li', null, 'Click "Generate token", copy it and paste it above. It is stored only on this computer (in the data folder, which is not uploaded to GitHub).'),
        ),
      ),
    ),
  );
}

export function renderAiStatus(state, ui) {
  const ai = state.ai;
  const chip = document.getElementById('ai-status-chip');
  if (!chip) return;
  let tone = 'warning';
  let label = 'No token';
  if (ai.tokenConfigured) {
    if (!ai.lastCheck) [tone, label] = ['info', 'Not tested yet'];
    else if (ai.lastCheck.ok) [tone, label] = ['success', 'Connected'];
    else [tone, label] = ['danger', 'Connection failed'];
  }
  chip.dataset.tone = tone;
  mount(chip, h('span', { className: 'dot' }), label);

  const usedBy = state.agents.filter((a) => a.mode === 'ai').map((a) => a.label);
  mount(
    'ai-status',
    ui.aiMessage ? h('p', { className: 'feedback', dataset: { tone: ui.aiMessage.tone } }, ui.aiMessage.text) : null,
    h(
      'p',
      { className: 'muted small' },
      ai.tokenConfigured ? `Token saved (${ai.tokenHint}). ` : 'No token saved. ',
      `Model: ${ai.model}. `,
      usedBy.length ? `AI-powered now: ${usedBy.join(', ')}.` : 'No agent is AI-powered yet.',
      ai.lastCheck ? ` Last test ${dateTime(ai.lastCheck.at)}: ${ai.lastCheck.message}` : '',
    ),
  );
}

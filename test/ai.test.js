import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer } from '../src/server/app.js';
import { GitHubModelsClient, parseJsonReply } from '../src/ai/githubModels.js';
import { validateDevReply, validatePoReply } from '../src/ai/contracts.js';
import { computeAnalytics } from '../src/analytics/analytics.js';
import { tempDir } from './helpers.js';

// A fake token in the GitHub format (never a real one).
const TOKEN = 'github_pat_TESTONLY0000000000000000000000abcd';
const REQUEST = 'create a web page with background green and font red. The phrase in the center of page "hello world"';

/**
 * A local stand-in for the GitHub Models endpoint: answers each request with
 * the next reply from `replies` and records what it received.
 */
async function mockModels(t, replies) {
  const received = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    received.push({ headers: req.headers, body });
    const reply = typeof replies[0] === 'function' ? replies.shift()(body) : replies.shift();
    if (!reply) {
      res.writeHead(500).end('no reply prepared');
      return;
    }
    if (reply.status) {
      res.writeHead(reply.status, reply.headers ?? {}).end(reply.text ?? '');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'openai/gpt-4.1-mini',
        choices: [{ message: { role: 'assistant', content: typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content) } }],
        usage: { prompt_tokens: 120, completion_tokens: 340 },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/inference/chat/completions`, received, replies };
}

const PO_SPEC = {
  status: 'ready',
  title: 'Green hello world page',
  summary: 'A page with a green background and red, centred "hello world".',
  requirements: ['The page background is green.', 'The text is red.', 'The phrase "hello world" is shown in the centre of the page.'],
  acceptanceCriteria: [
    { description: 'The page shows the phrase "hello world".', check: { type: 'textVisible', path: 'index.html', text: 'hello world' } },
    { description: 'The page background is green.', check: { type: 'cssProperty', property: 'background-color', value: 'green' } },
    { description: 'The text is red.', check: { type: 'cssProperty', property: 'color', value: 'red' } },
    { description: 'The phrase is centred on the page.', check: { type: 'centeredLayout' } },
  ],
  handoffMessage: 'Build the page so that each criterion passes.',
};

const page = (color) => ({
  files: [
    {
      path: 'index.html',
      purpose: 'The page',
      content: `<!doctype html><html><head><title>Hello</title><link rel="stylesheet" href="style.css"></head><body><p>hello world</p></body></html>`,
    },
    { path: 'style.css', purpose: 'Styles', content: `body { background-color: green; display: flex; justify-content: center; align-items: center; min-height: 100vh; }\np { color: ${color}; }\n` },
  ],
  summary: 'Built the page.',
  handoffMessage: 'Ready for QA.',
});

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function aiApp(t, replies, { devMode = 'ai' } = {}) {
  const mock = await mockModels(t, replies);
  const app = await startServer({ port: 0, dataDir: await tempDir(t), aiEndpoint: mock.url });
  t.after(() => app.close());
  await fetch(`${app.url}/api/ai`, json('PUT', { token: TOKEN }));
  await fetch(`${app.url}/api/agents/po`, json('PUT', { mode: 'ai' }));
  if (devMode === 'ai') await fetch(`${app.url}/api/agents/dev`, json('PUT', { mode: 'ai' }));
  return { app, mock };
}

async function run(app, request = REQUEST) {
  const { workflow, done } = app.orchestrator.submit(request);
  await done;
  return { workflow: app.repository.getWorkflow(workflow.id), events: app.repository.listEvents(workflow.id) };
}

test('AI PO and AI Developer build exactly what was asked; scripted QA verifies it independently', async (t) => {
  const { app, mock } = await aiApp(t, [{ content: PO_SPEC }, { content: page('red') }]);
  const { workflow, events } = await run(app);

  assert.equal(workflow.status, 'completed');
  assert.equal(workflow.verified, true);
  assert.equal(workflow.title, 'Green hello world page');

  // Real requests were sent with the token and the user's words.
  assert.equal(mock.received.length, 2);
  assert.equal(mock.received[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(mock.received[0].body.messages.some((m) => m.content.includes('background green and font red')));
  assert.equal(mock.received[0].body.model, 'openai/gpt-4.1-mini');

  // Every detail became a criterion, plus the entry page added by the workspace.
  const spec = workflow.state.spec;
  assert.deepEqual(spec.acceptanceCriteria.map((c) => c.check.type), ['textVisible', 'cssProperty', 'cssProperty', 'centeredLayout', 'fileExists']);

  // Labels: AI where a model decided, scripted for QA and the acceptance rule.
  const byType = (type) => events.filter((e) => e.type === type);
  assert.equal(byType('ai.call').length, 2);
  assert.ok(byType('ai.call').every((e) => e.actorKind === 'ai' && e.status === 'success'));
  assert.equal(byType('po.requirements')[0].actorKind, 'ai');
  assert.equal(byType('dev.implementation')[0].actorKind, 'ai');
  assert.equal(byType('qa.verdict')[0].actorKind, 'scripted');
  assert.equal(byType('po.review')[0].actorKind, 'scripted', 'acceptance is rule-based');

  // QA's tests really ran against the generated files.
  const results = byType('test.results')[0].detail;
  assert.equal(results.summary.fail, 0);
  assert.equal(results.summary.pass, 5);

  // The Live Preview serves the generated page.
  const preview = await (await fetch(`${app.url}/api/preview`, json('POST', { workflowId: workflow.id }))).json();
  assert.equal(preview.status, 'running');
  assert.match(await (await fetch(preview.url)).text(), /hello world/);
});

test('a wrong colour from the AI Developer is caught by QA and corrected', async (t) => {
  const { app, mock } = await aiApp(t, [{ content: PO_SPEC }, { content: page('blue') }, { content: page('red') }]);
  const { workflow, events } = await run(app);

  assert.equal(workflow.status, 'completed');
  const first = events.filter((e) => e.type === 'test.results')[0].detail.summary;
  assert.equal(first.fail, 1, 'the blue text really failed the red criterion');
  const defect = events.find((e) => e.type === 'defect.reported');
  assert.match(defect.detail.actual, /expected a CSS rule setting color: red; found: .*color: blue/);
  // The correction request carried QA's defects and the current files.
  const correction = JSON.parse(mock.received[2].body.messages[1].content.split('\n').slice(1).join('\n'));
  assert.equal(correction.defectsReportedByQA.length, 1);
  assert.ok(correction.currentFiles.some((f) => f.path === 'style.css' && f.content.includes('blue')));
});

test('when GitHub Models is unavailable the workflow blocks with the reason and resumes later', async (t) => {
  const { app, mock } = await aiApp(t, [{ status: 429, headers: { 'retry-after': '60' } }]);
  const { workflow, events } = await run(app);

  assert.equal(workflow.status, 'blocked');
  assert.equal(workflow.stage, 'analysis');
  assert.match(workflow.blockedReason, /free GitHub Models limit was reached.*retry after about 60 s/);
  const blocked = events.find((e) => e.type === 'workflow.blocked');
  assert.equal(blocked.detail.cause, 'ai_unavailable');
  assert.equal(events.find((e) => e.type === 'ai.call').status, 'failure');
  assert.ok(!events.some((e) => e.type === 'po.requirements'), 'no analysis is claimed');

  mock.replies.push({ content: PO_SPEC }, { content: page('red') });
  const resumed = await app.orchestrator.resume(workflow.id).done;
  assert.equal(resumed.status, 'completed');

  const analytics = computeAnalytics(app.repository.analyticsSource(), {}, { agents: [] });
  const kpi = (key) => analytics.kpis.find((k) => k.key === key);
  assert.equal(kpi('blocks').value, 0, 'not counted as a disabled-agent block');
  assert.equal(kpi('otherBlocks').value, 1);
  assert.equal(kpi('aiCalls').value, 3);
  assert.match(kpi('aiCalls').detail, /^2 succeeded/);
});

test('an unusable model answer is retried once, then reported instead of guessed', async (t) => {
  const bad = { content: { status: 'ready', title: 'x', requirements: ['a'], acceptanceCriteria: [{ description: 'd', check: { type: 'looksNice' } }] } };
  const { app, mock } = await aiApp(t, [bad, bad]);
  const { workflow, events } = await run(app);
  assert.equal(mock.received.length, 2);
  assert.match(mock.received[1].body.messages[1].content, /unknown check type "looksNice"/);
  assert.equal(workflow.status, 'blocked');
  assert.match(workflow.blockedReason, /did not match the required format/);
  assert.equal(events.filter((e) => e.type === 'ai.call').length, 2);
});

test('the AI PO asks for clarification when a request cannot be built as a static page', async (t) => {
  const { app } = await aiApp(t, [{ content: { status: 'needs_clarification', reason: 'unsupported', message: 'A database is not possible in a static page. Should the data be stored in the browser instead?' } }]);
  const { workflow, events } = await run(app, 'Build a page that saves users in a database');
  assert.equal(workflow.status, 'needs_clarification');
  const question = events.find((e) => e.type === 'po.clarification');
  assert.equal(question.actorKind, 'ai');
  assert.match(question.summary, /stored in the browser/);
});

test('an AI PO with a scripted Developer blocks with a clear way forward', async (t) => {
  const { app } = await aiApp(t, [{ content: PO_SPEC }, { content: page('red') }], { devMode: 'scripted' });
  const { workflow } = await run(app);
  assert.equal(workflow.status, 'blocked');
  assert.equal(workflow.stage, 'implementation');
  assert.match(workflow.blockedReason, /Switch the Developer to AI mode/);

  await fetch(`${app.url}/api/agents/dev`, json('PUT', { mode: 'ai' }));
  const resumed = await app.orchestrator.resume(workflow.id).done;
  assert.equal(resumed.status, 'completed');
  assert.equal(app.repository.listTasks(workflow.id).filter((x) => x.stage === 'analysis').length, 1, 'analysis was not repeated');
});

test('the token is stored locally and never sent back to the browser', async (t) => {
  const { app } = await aiApp(t, []);
  for (const path of ['/api/state', '/api/ai']) {
    const text = await (await fetch(app.url + path)).text();
    assert.ok(!text.includes(TOKEN), path);
  }
  const ai = await (await fetch(`${app.url}/api/ai`)).json();
  assert.equal(ai.tokenConfigured, true);
  assert.equal(ai.tokenHint, '…abcd');
  assert.equal((await fetch(`${app.url}/api/ai`, json('PUT', { token: 'not a token' }))).status, 400);
  assert.equal((await fetch(`${app.url}/api/ai`, json('PUT', { model: 'bad model' }))).status, 400);
  await fetch(`${app.url}/api/ai`, json('PUT', { token: '' }));
  assert.equal((await (await fetch(`${app.url}/api/ai`)).json()).tokenConfigured, false);
});

test('modes: QA cannot be switched to AI, and mode changes are recorded', async (t) => {
  const { app } = await aiApp(t, []);
  const res = await fetch(`${app.url}/api/agents/qa`, json('PUT', { mode: 'ai' }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /always scripted/);
  const events = app.repository.listWorkspaceEvents().filter((e) => e.type === 'agent.mode');
  assert.deepEqual(events.map((e) => e.detail.agentId), ['po', 'dev']);
  assert.match(events[0].summary, /PO switched to AI-powered \(GitHub Models, openai\/gpt-4\.1-mini\)/);
  const state = await (await fetch(`${app.url}/api/state`)).json();
  assert.deepEqual(state.agents.map((a) => `${a.id}:${a.mode}:${a.kind}`), ['po:ai:ai', 'dev:ai:ai', 'qa:scripted:scripted']);
});

test('the connection test reports the real outcome', async (t) => {
  const { app } = await aiApp(t, [{ content: { ok: true } }, { status: 401 }]);
  const ok = await (await fetch(`${app.url}/api/ai/test`, { method: 'POST' })).json();
  assert.equal(ok.ok, true);
  const bad = await (await fetch(`${app.url}/api/ai/test`, { method: 'POST' })).json();
  assert.equal(bad.ok, false);
  assert.match(bad.message, /rejected the token/);
  assert.equal((await (await fetch(`${app.url}/api/ai`)).json()).lastCheck.ok, false);
});

test('unexpected responses are described for diagnosis; event streams are reassembled', async (t) => {
  const { url } = await mockModels(t, [
    { status: 200, headers: { 'Content-Type': 'text/html' }, text: '<!DOCTYPE html><html><title>Sign in</title> github_pat_SECRET123</html>' },
    { status: 200, headers: { 'Content-Type': 'text/event-stream' }, text: 'data: {"model":"m","choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\ndata: {"choices":[{"delta":{"content":"true}"}}]}\n\ndata: [DONE]\n\n' },
  ]);
  const client = new GitHubModelsClient({ token: TOKEN, endpoint: url });
  const error = await client.chatJson({ system: 's', user: 'u' }).catch((e) => e);
  assert.equal(error.kind, 'invalid_response');
  assert.match(error.message, /HTTP 200, content-type text\/html; the response starts with: "<!DOCTYPE html><html><title>Sign in<\/title> \[token\]/);
  assert.ok(!error.message.includes('SECRET123'), 'tokens are never echoed');
  const streamed = await client.chatJson({ system: 's', user: 'u' });
  assert.deepEqual(streamed.json, { ok: true });
});

test('requests use the documented GitHub headers and disable streaming', async (t) => {
  const mock = await mockModels(t, [{ content: { ok: true } }]);
  await new GitHubModelsClient({ token: TOKEN, endpoint: mock.url }).chatJson({ system: 's', user: 'u' });
  assert.equal(mock.received[0].headers.accept, 'application/vnd.github+json');
  assert.equal(mock.received[0].headers['x-github-api-version'], '2022-11-28');
  assert.equal(mock.received[0].body.stream, false);
});

test('client errors are classified; JSON replies are parsed strictly', async () => {
  const unreachable = new GitHubModelsClient({ token: TOKEN, endpoint: 'http://127.0.0.1:9/none', timeoutMs: 2000 });
  await assert.rejects(unreachable.chatJson({ system: 's', user: 'u' }), (e) => e.kind === 'network');
  await assert.rejects(new GitHubModelsClient({ token: '' }).chatJson({ system: 's', user: 'u' }), (e) => e.kind === 'not_configured');
  assert.deepEqual(parseJsonReply('```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseJsonReply('not json'), (e) => e.kind === 'invalid_response');
  assert.throws(() => parseJsonReply('[1,2]'), (e) => e.kind === 'invalid_response');
});

test('contracts reject unsafe or unverifiable model output', () => {
  assert.throws(() => validatePoReply({ status: 'ready', title: 't', requirements: ['r'], acceptanceCriteria: [{ description: 'd', check: { type: 'eval', code: 'x' } }] }), /unknown check type/);
  const ok = validatePoReply({ status: 'ready', title: 't', requirements: ['r'], acceptanceCriteria: [{ description: 'd', check: { type: 'centeredLayout' } }] });
  assert.equal(ok.acceptanceCriteria.at(-1).check.path, 'index.html', 'entry page criterion added');

  const file = (path, content = 'x') => ({ files: [{ path: 'index.html', content: '<p>hi</p>' }, { path, content }] });
  assert.throws(() => validateDevReply(file('../escape.js')), /simple relative path/);
  assert.throws(() => validateDevReply(file('test/fake.test.js')), /reserved for QA/);
  assert.throws(() => validateDevReply(file('.env')), /simple relative path/);
  assert.throws(() => validateDevReply(file('app.exe')), /only .* files are allowed/);
  assert.throws(() => validateDevReply(file('app.js', '<script src="https://cdn.example.com/x.js"></script>')), /external resources/);
  assert.throws(() => validateDevReply({ files: [{ path: 'page.html', content: 'x' }] }), /index.html is required/);
  assert.equal(validateDevReply(file('app.js', 'console.log(1)')).files.length, 2);
});

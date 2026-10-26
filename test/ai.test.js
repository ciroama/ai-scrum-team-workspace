import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer } from '../src/server/app.js';
import { ClaudeCodeClient, parseJsonReply } from '../src/ai/claudeCode.js';
import { validateDevReply, validatePoReply } from '../src/ai/contracts.js';
import { computeAnalytics } from '../src/analytics/analytics.js';
import { tempDir } from './helpers.js';

const REQUEST = 'create a web page with background green and font red. The phrase in the center of page "hello world"';

// A local stand-in for the `claude` command. It answers each run with the
// next prepared reply (in the JSON shape `claude -p --output-format json`
// prints) and records the arguments, prompt, working folder and environment
// it received.
const FAKE_CLAUDE = `#!${process.execPath}
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const dir = __dirname;
let stdin = '';
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', () => {
  const replies = JSON.parse(readFileSync(join(dir, 'replies.json'), 'utf8'));
  const received = JSON.parse(readFileSync(join(dir, 'received.json'), 'utf8'));
  received.push({ args: process.argv.slice(2), stdin, cwd: process.cwd(), apiKey: process.env.ANTHROPIC_API_KEY ?? null });
  writeFileSync(join(dir, 'received.json'), JSON.stringify(received));
  const reply = replies.shift();
  writeFileSync(join(dir, 'replies.json'), JSON.stringify(replies));
  const model = process.argv[process.argv.indexOf('--model') + 1];
  if (!reply) { process.stderr.write('no reply prepared'); process.exit(1); }
  if (reply.sleepMs) { setTimeout(() => {}, reply.sleepMs); return; }
  if (reply.raw !== undefined) { process.stdout.write(reply.raw); process.stderr.write(reply.stderr ?? ''); process.exit(reply.exit ?? 0); }
  const error = reply.error !== undefined;
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: error,
    api_error_status: reply.status ?? null,
    duration_ms: 1500,
    result: error ? reply.error : typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content),
    usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 18, output_tokens: 340 },
    modelUsage: { ['claude-' + model + '-test']: { inputTokens: 2, outputTokens: 340 } },
  }));
  process.exit(error ? 1 : 0);
});
`;

async function fakeClaude(t, replies) {
  const dir = await tempDir(t);
  const binary = join(dir, 'claude');
  await writeFile(binary, FAKE_CLAUDE);
  await chmod(binary, 0o755);
  const write = (list) => writeFile(join(dir, 'replies.json'), JSON.stringify(list));
  await write(replies);
  await writeFile(join(dir, 'received.json'), '[]');
  return {
    binary,
    received: async () => JSON.parse(await readFile(join(dir, 'received.json'), 'utf8')),
    push: async (...more) => write([...JSON.parse(await readFile(join(dir, 'replies.json'), 'utf8')), ...more]),
  };
}

const option = (args, name) => args[args.indexOf(name) + 1];

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
  const claude = await fakeClaude(t, replies);
  const app = await startServer({ port: 0, dataDir: await tempDir(t), claudeBinary: claude.binary });
  t.after(() => app.close());
  await fetch(`${app.url}/api/agents/po`, json('PUT', { mode: 'ai' }));
  if (devMode === 'ai') await fetch(`${app.url}/api/agents/dev`, json('PUT', { mode: 'ai' }));
  return { app, claude };
}

async function run(app, request = REQUEST) {
  const { workflow, done } = app.orchestrator.submit(request);
  await done;
  return { workflow: app.repository.getWorkflow(workflow.id), events: app.repository.listEvents(workflow.id) };
}

test('AI PO and AI Developer build exactly what was asked; scripted QA verifies it independently', async (t) => {
  const { app, claude } = await aiApp(t, [{ content: PO_SPEC }, { content: page('red') }]);
  const { workflow, events } = await run(app);

  assert.equal(workflow.status, 'completed');
  assert.equal(workflow.verified, true);
  assert.equal(workflow.title, 'Green hello world page');

  // Claude Code really ran twice, with the user's words, the default model and no tools.
  const received = await claude.received();
  assert.equal(received.length, 2);
  assert.match(received[0].stdin, /background green and font red/);
  assert.equal(option(received[0].args, '--model'), 'sonnet');
  assert.equal(option(received[0].args, '--output-format'), 'json');
  assert.equal(option(received[0].args, '--tools'), '');
  assert.match(option(received[0].args, '--system-prompt'), /Product Owner/);

  // Every detail became a criterion, plus the entry page added by the workspace.
  const spec = workflow.state.spec;
  assert.deepEqual(spec.acceptanceCriteria.map((c) => c.check.type), ['textVisible', 'cssProperty', 'cssProperty', 'centeredLayout', 'fileExists']);

  // Labels: AI where a model decided, scripted for QA and the acceptance rule.
  const byType = (type) => events.filter((e) => e.type === type);
  assert.equal(byType('ai.call').length, 2);
  assert.ok(byType('ai.call').every((e) => e.actorKind === 'ai' && e.status === 'success'));
  assert.match(byType('ai.call')[0].summary, /asked claude-sonnet-test via Claude Code to analyse the request in 1\.5 s, 120 → 340 tokens/);
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
  const { app, claude } = await aiApp(t, [{ content: PO_SPEC }, { content: page('blue') }, { content: page('red') }]);
  const { workflow, events } = await run(app);

  assert.equal(workflow.status, 'completed');
  const first = events.filter((e) => e.type === 'test.results')[0].detail.summary;
  assert.equal(first.fail, 1, 'the blue text really failed the red criterion');
  const defect = events.find((e) => e.type === 'defect.reported');
  assert.match(defect.detail.actual, /expected a CSS rule setting color: red; found: .*color: blue/);
  // The correction request carried QA's defects and the current files.
  const received = await claude.received();
  const correction = JSON.parse(received[2].stdin.split('\n').slice(1).join('\n'));
  assert.equal(correction.defectsReportedByQA.length, 1);
  assert.ok(correction.currentFiles.some((f) => f.path === 'style.css' && f.content.includes('blue')));
});

test('when the Claude usage limit is reached the workflow blocks with the reason and resumes later', async (t) => {
  const { app, claude } = await aiApp(t, [{ error: 'Claude AI usage limit reached|1761500000', status: 429 }]);
  const { workflow, events } = await run(app);

  assert.equal(workflow.status, 'blocked');
  assert.equal(workflow.stage, 'analysis');
  assert.match(workflow.blockedReason, /Claude usage limit was reached.*Wait until it resets, then resume/);
  const blocked = events.find((e) => e.type === 'workflow.blocked');
  assert.equal(blocked.detail.cause, 'ai_unavailable');
  assert.equal(blocked.detail.kind, 'rate_limit');
  assert.equal(events.find((e) => e.type === 'ai.call').status, 'failure');
  assert.ok(!events.some((e) => e.type === 'po.requirements'), 'no analysis is claimed');

  await claude.push({ content: PO_SPEC }, { content: page('red') });
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
  const { app, claude } = await aiApp(t, [bad, bad]);
  const { workflow, events } = await run(app);
  const received = await claude.received();
  assert.equal(received.length, 2);
  assert.match(received[1].stdin, /unknown check type "looksNice"/);
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

test('the model can be changed and is used for the next request; invalid names are refused', async (t) => {
  const { app, claude } = await aiApp(t, [{ content: { ok: true } }]);
  const ai = await (await fetch(`${app.url}/api/ai`)).json();
  assert.equal(ai.providerName, 'Claude Code');
  assert.equal(ai.model, 'sonnet');
  assert.equal((await fetch(`${app.url}/api/ai`, json('PUT', { model: 'opus; rm -rf /' }))).status, 400);
  assert.equal((await (await fetch(`${app.url}/api/ai`, json('PUT', { model: 'opus' }))).json()).model, 'opus');
  await fetch(`${app.url}/api/ai/test`, { method: 'POST' });
  assert.equal(option((await claude.received())[0].args, '--model'), 'opus');
  await fetch(`${app.url}/api/ai`, json('PUT', { model: '' }));
  assert.equal((await (await fetch(`${app.url}/api/ai`)).json()).model, 'sonnet', 'empty restores the default');
});

test('an old GitHub Models token is removed from the database on start', async (t) => {
  const dataDir = await tempDir(t);
  const first = await startServer({ port: 0, dataDir });
  first.repository.setSetting('ai.githubModels.token', 'github_pat_TESTONLY0000000000000000000000abcd');
  await first.close();
  const second = await startServer({ port: 0, dataDir });
  t.after(() => second.close());
  assert.equal(second.repository.getSetting('ai.githubModels.token'), null);
});

test('modes: QA cannot be switched to AI, and mode changes are recorded', async (t) => {
  const { app } = await aiApp(t, []);
  const res = await fetch(`${app.url}/api/agents/qa`, json('PUT', { mode: 'ai' }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /always scripted/);
  const events = app.repository.listWorkspaceEvents().filter((e) => e.type === 'agent.mode');
  assert.deepEqual(events.map((e) => e.detail.agentId), ['po', 'dev']);
  assert.match(events[0].summary, /PO switched to AI-powered \(Claude Code, sonnet\)/);
  const state = await (await fetch(`${app.url}/api/state`)).json();
  assert.deepEqual(state.agents.map((a) => `${a.id}:${a.mode}:${a.kind}`), ['po:ai:ai', 'dev:ai:ai', 'qa:scripted:scripted']);
});

test('the connection test reports the real outcome', async (t) => {
  const { app } = await aiApp(t, [{ content: { ok: true } }, { error: 'Invalid API key · Please run /login', status: 401 }]);
  const ok = await (await fetch(`${app.url}/api/ai/test`, { method: 'POST' })).json();
  assert.equal(ok.ok, true);
  assert.match(ok.message, /Claude Code answered \(claude-sonnet-test\)/);
  const bad = await (await fetch(`${app.url}/api/ai/test`, { method: 'POST' })).json();
  assert.equal(bad.ok, false);
  assert.match(bad.message, /not logged in.*Run "claude" in a terminal/);
  assert.equal((await (await fetch(`${app.url}/api/ai`)).json()).lastCheck.ok, false);
});

test('Claude Code runs in an empty folder and never receives an API key', async (t) => {
  const claude = await fakeClaude(t, [{ content: '```json\n{"ok":true}\n```' }]);
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-TESTONLY';
  t.after(() => (saved === undefined ? delete process.env.ANTHROPIC_API_KEY : (process.env.ANTHROPIC_API_KEY = saved)));
  const answer = await new ClaudeCodeClient({ binary: claude.binary }).chatJson({ system: 's', user: 'u' });
  assert.deepEqual(answer.json, { ok: true });
  assert.deepEqual(answer.usage, { promptTokens: 120, completionTokens: 340 });
  const [call] = await claude.received();
  assert.equal(call.apiKey, null, 'the subscription login is used, not paid API access');
  assert.match(call.cwd, /scrum-ai-/);
});

test('client errors are classified; JSON replies are parsed strictly', async (t) => {
  await assert.rejects(new ClaudeCodeClient({ binary: '/nonexistent/claude' }).chatJson({ system: 's', user: 'u' }), (e) => e.kind === 'not_configured' && /not installed/.test(e.message));
  const claude = await fakeClaude(t, [{ sleepMs: 5000 }, { raw: 'Error: something broke', exit: 1 }, { raw: 'not json', exit: 0 }]);
  await assert.rejects(new ClaudeCodeClient({ binary: claude.binary, timeoutMs: 500 }).chatJson({ system: 's', user: 'u' }), (e) => e.kind === 'timeout');
  await assert.rejects(new ClaudeCodeClient({ binary: claude.binary }).chatJson({ system: 's', user: 'u' }), (e) => e.kind === 'service' && /something broke/.test(e.message));
  await assert.rejects(new ClaudeCodeClient({ binary: claude.binary }).chatJson({ system: 's', user: 'u' }), (e) => e.kind === 'invalid_response');
  assert.deepEqual(parseJsonReply('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonReply('Here it is:\n{"a":1}'), { a: 1 });
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

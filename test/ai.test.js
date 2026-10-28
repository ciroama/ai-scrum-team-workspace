import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer } from '../src/server/app.js';
import { ClaudeCodeClient, parseJsonReply } from '../src/ai/claudeCode.js';
import { validateDevReply, validatePoReply } from '../src/ai/contracts.js';
import { computeAnalytics } from '../src/analytics/analytics.js';
import { gitAvailable, tempDir } from './helpers.js';

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

// The PO's final review (an AI decision since the PO is AI-powered).
const ACCEPT = { content: { decision: 'accept', summary: 'Accepted: the page does what was asked and QA verified every criterion.', reasons: ['All criteria verified.'] } };

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
  const { app, claude } = await aiApp(t, [{ content: PO_SPEC }, { content: page('red') }, ACCEPT]);
  const { workflow, events } = await run(app);

  assert.equal(workflow.status, 'completed');
  assert.equal(workflow.verified, true);
  assert.equal(workflow.title, 'Green hello world page');

  // Claude Code really ran three times (analysis, implementation, review),
  // with the user's words, the default model and no tools.
  const received = await claude.received();
  assert.equal(received.length, 3);
  assert.match(received[0].stdin, /background green and font red/);
  assert.equal(option(received[0].args, '--model'), 'sonnet');
  assert.equal(option(received[0].args, '--output-format'), 'json');
  assert.equal(option(received[0].args, '--tools'), '');
  assert.match(option(received[0].args, '--system-prompt'), /Product Owner/);

  // Every detail became a criterion, plus the entry page added by the workspace.
  const spec = workflow.state.spec;
  assert.deepEqual(spec.acceptanceCriteria.map((c) => c.check.type), ['textVisible', 'cssProperty', 'cssProperty', 'centeredLayout', 'fileExists']);

  // Labels: AI where a model decided, scripted for QA.
  const byType = (type) => events.filter((e) => e.type === type);
  assert.equal(byType('ai.call').length, 3);
  assert.ok(byType('ai.call').every((e) => e.actorKind === 'ai' && e.status === 'success'));
  assert.match(byType('ai.call')[0].summary, /asked claude-sonnet-test via Claude Code to analyse the request in 1\.5 s, 120 → 340 tokens/);
  assert.equal(byType('po.requirements')[0].actorKind, 'ai');
  assert.equal(byType('dev.implementation')[0].actorKind, 'ai');
  assert.equal(byType('qa.verdict')[0].actorKind, 'scripted');
  const review = byType('po.review')[0];
  assert.equal(review.actorKind, 'ai', 'the AI-powered PO decides the acceptance');
  assert.equal(review.detail.decidedBy, 'ai');
  assert.deepEqual(review.detail.reasons, ['All criteria verified.']);
  // The review saw QA's evidence and the product files.
  const reviewInput = JSON.parse(received[2].stdin);
  assert.equal(reviewInput.qaVerification.verdict, 'pass');
  assert.ok(reviewInput.files.some((f) => f.path === 'style.css'));
  assert.ok(!reviewInput.files.some((f) => f.path.startsWith('test/')));

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
  const { app, claude } = await aiApp(t, [{ content: PO_SPEC }, { content: page('blue') }, { content: page('red') }, ACCEPT]);
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

  await claude.push({ content: PO_SPEC }, { content: page('red') }, ACCEPT);
  const resumed = await app.orchestrator.resume(workflow.id).done;
  assert.equal(resumed.status, 'completed');

  const analytics = computeAnalytics(app.repository.analyticsSource(), {}, { agents: [] });
  const kpi = (key) => analytics.kpis.find((k) => k.key === key);
  assert.equal(kpi('blocks').value, 0, 'not counted as a disabled-agent block');
  assert.equal(kpi('otherBlocks').value, 1);
  assert.equal(kpi('aiCalls').value, 4);
  assert.match(kpi('aiCalls').detail, /^3 succeeded/);
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
  const { app } = await aiApp(t, [{ content: PO_SPEC }, { content: page('red') }, ACCEPT], { devMode: 'scripted' });
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

test('a change request builds on the current requirements and files of the same product', async (t) => {
  const changed = {
    ...PO_SPEC,
    changes: ['Changed: the text colour is now blue (was red).'],
    requirements: ['The page background is green.', 'The text is blue.', 'The phrase "hello world" is shown in the centre of the page.'],
    acceptanceCriteria: PO_SPEC.acceptanceCriteria.map((c) => (c.check.property === 'color' ? { description: 'The text is blue.', check: { type: 'cssProperty', property: 'color', value: 'blue' } } : c)),
  };
  const { app, claude } = await aiApp(t, [{ content: PO_SPEC }, { content: page('red') }, ACCEPT, { content: changed }, { content: { ...page('blue'), summary: 'Changed the colour.' } }, ACCEPT]);
  const { workflow: first } = await run(app);
  assert.equal(first.status, 'completed');

  const { workflow: cr, done } = app.orchestrator.submit('make the text blue', { productId: first.productId });
  await done;
  const second = app.repository.getWorkflow(cr.id);
  assert.equal(second.status, 'completed');
  assert.equal(second.productId, first.id, 'the change belongs to the same product');
  assert.equal(second.state.spec.version, 2);
  assert.deepEqual(second.state.spec.changes, ['Changed: the text colour is now blue (was red).']);

  // The PO received the current requirements, the Developer the current files.
  const received = await claude.received();
  const poInput = JSON.parse(received[3].stdin);
  assert.equal(poInput.changeRequest, 'make the text blue');
  assert.equal(poInput.currentRequirements.version, 1);
  assert.ok(poInput.currentRequirements.requirements.includes('The text is red.'));
  assert.match(option(received[3].args, '--system-prompt'), /The product already exists/);
  const devInput = JSON.parse(received[4].stdin.split('\n').slice(1).join('\n'));
  assert.ok(devInput.currentFiles.some((f) => f.path === 'index.html' && f.content.includes('hello world')));

  // Same folder and Git repository, with the history of both iterations;
  // QA re-ran every criterion against the changed product.
  assert.equal(app.orchestrator.productDir(cr.id), app.orchestrator.productDir(first.id));
  const files = (await app.orchestrator.listProductFiles(cr.id)).files;
  assert.match(files.find((f) => f.path === 'index.html').content, /hello world/);
  assert.match(files.find((f) => f.path === 'style.css').content, /color: blue/);
  assert.match(files.find((f) => f.path === 'REQUIREMENTS.md').content, /version 2[\s\S]*Changes in this version[\s\S]*now blue/);
  const results = app.repository.listEvents(cr.id).find((e) => e.type === 'test.results').detail.summary;
  assert.equal(results.pass, 5);
  if (await gitAvailable()) {
    const commits = [first.id, cr.id].flatMap((id) => app.repository.listEvents(id).filter((e) => e.type === 'git.commit'));
    assert.equal(new Set(commits.map((e) => e.detail.repository)).size, 1);
    assert.ok(commits.length >= 4);
  }

  const detail = await (await fetch(`${app.url}/api/products/${first.id}`)).json();
  assert.equal(detail.product.iterations, 2);
  assert.deepEqual(detail.iterations.map((i) => [i.change, i.spec.version]), [[false, 1], [true, 2]]);
});

test('the scripted PO refuses change requests honestly; unknown products are rejected', async (t) => {
  const { app } = await aiApp(t, [{ content: PO_SPEC }, { content: page('red') }, ACCEPT]);
  const { workflow } = await run(app);
  await fetch(`${app.url}/api/agents/po`, json('PUT', { mode: 'scripted' }));
  const { workflow: cr, done } = app.orchestrator.submit('make the text blue', { productId: workflow.productId });
  await done;
  const result = app.repository.getWorkflow(cr.id);
  assert.equal(result.status, 'needs_clarification');
  assert.match(app.repository.listEvents(cr.id).find((e) => e.type === 'po.clarification').summary, /scripted PO.*cannot change "Green hello world page"/);

  const res = await fetch(`${app.url}/api/workflows`, json('POST', { request: 'make it blue', productId: 'wf-missing' }));
  assert.equal(res.status, 404);
});

test('deleting a product removes its requests, events, statistics and files for good', async (t) => {
  const { app } = await aiApp(t, [{ content: PO_SPEC }, { content: page('red') }, ACCEPT, { content: PO_SPEC }, { content: page('red') }, ACCEPT]);
  const { workflow: keep } = await run(app);
  const { workflow: doomed } = await run(app);
  const dir = app.orchestrator.productDir(doomed.id);
  const preview = await (await fetch(`${app.url}/api/preview`, json('POST', { workflowId: doomed.id }))).json();
  assert.equal(preview.status, 'running');

  const res = await fetch(`${app.url}/api/products/${doomed.productId}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.ok(!app.repository.getWorkflow(doomed.id));
  assert.equal(app.repository.listEvents(doomed.id).length, 0);
  assert.equal(app.repository.listTasks(doomed.id).length, 0);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(dir), false, 'the product folder is gone');
  assert.equal(existsSync(app.orchestrator.productDir(keep.id)), true, 'other products are untouched');
  assert.equal((await (await fetch(`${app.url}/api/preview`)).json()).status, 'not_started', 'its preview was stopped');
  assert.deepEqual(app.repository.analyticsSource().workflows.map((w) => w.id), [keep.id]);
  assert.equal((await fetch(`${app.url}/api/products/${doomed.productId}`, { method: 'DELETE' })).status, 404);

  assert.equal((await fetch(`${app.url}/api/products`, { method: 'DELETE' })).status, 400, 'deleting everything needs confirmation');
  assert.equal((await fetch(`${app.url}/api/products?confirm=all`, { method: 'DELETE' })).status, 200);
  const state = await (await fetch(`${app.url}/api/state`)).json();
  assert.deepEqual([state.workflows.length, state.products.length, state.focusWorkflowId], [0, 0, null]);
});

test('a running workflow cannot be deleted', async (t) => {
  const { app } = await aiApp(t, [{ sleepMs: 1500 }]);
  const { workflow, done } = app.orchestrator.submit(REQUEST);
  const res = await fetch(`${app.url}/api/products/${workflow.productId}`, { method: 'DELETE' });
  assert.equal(res.status, 409);
  await done;
});

test('answering the PO continues the same request with the whole dialogue', async (t) => {
  const question = { content: { status: 'needs_clarification', reason: 'ambiguous', message: 'Should the text be red or blue?' } };
  const { app, claude } = await aiApp(t, [question, question, { content: PO_SPEC }, { content: page('red') }, ACCEPT]);
  const { workflow } = await run(app, 'change the background in green and the font color in red or blu');
  assert.equal(workflow.status, 'needs_clarification');

  await app.orchestrator.answer(workflow.id, 'red').done;
  assert.equal(app.repository.getWorkflow(workflow.id).status, 'needs_clarification', 'the PO may ask again');
  const done = await app.orchestrator.answer(workflow.id, 'hello world in red').done;
  assert.equal(done.status, 'completed');
  assert.equal(done.verified, true);

  // One request, one product, one version; the PO saw every question and answer.
  assert.equal(app.repository.listWorkflows().length, 1);
  assert.deepEqual(done.state.dialogue.map((d) => d.answer), ['red', 'hello world in red']);
  const received = await claude.received();
  assert.match(received[2].stdin, /1\. PO: Should the text be red or blue\?\n {3}User: red\n2\. PO: Should the text be red or blue\?\n {3}User: hello world in red/);
  const events = app.repository.listEvents(workflow.id);
  assert.equal(events.filter((e) => e.type === 'clarification.answered').length, 2);
  assert.equal(events.filter((e) => e.type === 'po.clarification').length, 2);
  const product = app.repository.listProducts()[0];
  assert.deepEqual([product.iterations, product.versions, product.current.status, product.current.verified], [1, 1, 'completed', true]);

  // Only a request whose PO is waiting can be answered.
  assert.equal((await fetch(`${app.url}/api/workflows/${workflow.id}/answer`, json('POST', { answer: 'blue' }))).status, 409);
});

test('the scripted PO matches the answer when the user rephrases the request', async (t) => {
  const ctx = await (await import('./helpers.js')).setup(t);
  const asked = await ctx.orchestrator.submit('Build a futuristic Breakout game').done;
  assert.equal(asked.status, 'needs_clarification');
  const done = await ctx.orchestrator.answer(asked.id, 'Build a simple Hello World web application').done;
  assert.equal(done.status, 'completed');
  assert.equal(done.id, asked.id);
});

test('the AI PO may reject a product whose tests pass, but never accept one QA did not verify', async (t) => {
  const reject = { content: { decision: 'reject', summary: 'Not accepted: the text is centred with a hard-coded margin that breaks on small screens.', reasons: ['Layout not responsive'] } };
  const { app, claude } = await aiApp(t, [{ content: PO_SPEC }, { content: page('red') }, reject]);
  const { workflow, events } = await run(app);
  assert.equal(workflow.status, 'failed');
  assert.equal(workflow.verified, false, 'not accepted, so not delivered as verified');
  assert.equal(workflow.state.verification.verdict, 'pass', 'QA still records that its tests passed');
  assert.match(events.find((e) => e.type === 'po.review').summary, /hard-coded margin/);

  // With failing tests an "accept" breaks the contract: the PO is asked again and must reject.
  const accept = { content: { decision: 'accept', summary: 'Looks fine to me.' } };
  const blue = page('blue');
  await claude.push({ content: PO_SPEC }, { content: blue }, { content: blue }, { content: blue }, accept, { content: { decision: 'reject', summary: 'Not accepted: the text is still blue, QA reports it.' } });
  const second = await run(app);
  assert.equal(second.workflow.status, 'failed');
  const received = await claude.received();
  assert.match(received.at(-1).stdin, /the only allowed decision is "reject"/);
  assert.match(option(received.at(-2).args, '--system-prompt'), /QA did NOT verify every acceptance criterion: you must reject/);
});

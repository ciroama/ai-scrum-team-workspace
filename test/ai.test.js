import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer } from '../src/server/app.js';
import { ClaudeCodeClient, parseJsonReply } from '../src/ai/claudeCode.js';
import { validateDevReply, validatePoReply, validateTeamAnswerReply } from '../src/ai/contracts.js';
import { ProductOwnerAgent } from '../src/agents/productOwner.js';
import { requestsCsv } from '../src/analytics/export.js';
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
  assumptions: [{ text: 'The phrase is exactly "hello world", in lower case.', decidedBy: 'user' }],
  whyNoQuestions: 'The request names the colours, the phrase and its position; nothing else is asked for.',
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

async function aiApp(t, replies, { devMode = 'ai', qaMode = 'scripted' } = {}) {
  const claude = await fakeClaude(t, replies);
  const app = await startServer({ port: 0, dataDir: await tempDir(t), claudeBinary: claude.binary });
  t.after(() => app.close());
  await fetch(`${app.url}/api/agents/po`, json('PUT', { mode: 'ai' }));
  if (devMode === 'ai') await fetch(`${app.url}/api/agents/dev`, json('PUT', { mode: 'ai' }));
  if (qaMode === 'ai') await fetch(`${app.url}/api/agents/qa`, json('PUT', { mode: 'ai' }));
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
  // The PO asked nothing, and its reason is recorded.
  assert.equal(events.find((e) => e.type === 'po.requirements').detail.whyNoQuestions, PO_SPEC.whyNoQuestions);

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
  // The review saw QA's evidence, never the code: a PO does not read the implementation.
  const reviewInput = JSON.parse(received[2].stdin);
  assert.equal(reviewInput.qaVerification.verdict, 'pass');
  assert.equal(reviewInput.files, undefined);
  assert.doesNotMatch(received[2].stdin, /hello world<\/p>|<html|color:/i);

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
  assert.equal(correction.problemsReported.length, 1);
  assert.equal(correction.problemsReported[0].reportedBy, 'QA');
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

test('modes: every agent can be scripted or AI-powered, and mode changes are recorded', async (t) => {
  const { app } = await aiApp(t, [], { qaMode: 'ai' });
  assert.equal((await fetch(`${app.url}/api/agents/qa`, json('PUT', { mode: 'robot' }))).status, 400);
  const events = app.repository.listWorkspaceEvents().filter((e) => e.type === 'agent.mode');
  assert.deepEqual(events.map((e) => e.detail.agentId), ['po', 'dev', 'qa']);
  assert.match(events[0].summary, /PO switched to AI-powered \(Claude Code, sonnet\)/);
  const state = await (await fetch(`${app.url}/api/state`)).json();
  assert.deepEqual(state.agents.map((a) => `${a.id}:${a.mode}:${a.kind}:${a.supportsAi}`), ['po:ai:ai:true', 'dev:ai:ai:true', 'qa:ai:ai:true']);
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
  const ok = validatePoReply({ status: 'ready', title: 't', requirements: ['r'], acceptanceCriteria: [{ description: 'd', check: { type: 'centeredLayout' } }], assumptions: [] });
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

test('a verified product the AI PO rejects goes back to the Developer with the PO\'s reasons', async (t) => {
  const reject = { content: { decision: 'reject', summary: 'Not accepted: the phrase is not in the centre of the page.', reasons: [{ text: 'Centre the phrase on the page', origin: 'implementation' }] } };
  const { app, claude } = await aiApp(t, [{ content: PO_SPEC }, { content: page('red') }, reject, { content: page('red') }, ACCEPT]);
  const { workflow, events } = await run(app);
  assert.equal(workflow.status, 'completed');
  assert.equal(workflow.verified, true);
  assert.equal(workflow.state.attempt, 2, 'one rework after the first implementation');

  // The rejection was handed to the Developer, who received the PO's reasons.
  const rework = events.find((e) => e.type === 'handoff' && e.from === 'po' && e.to === 'dev' && e.status === 'failure');
  assert.match(rework.summary, /Not accepted yet: .*not in the centre.*attempt 2 of 3/);
  const received = await claude.received();
  const devInput = JSON.parse(received[3].stdin.split('\n').slice(1).join('\n'));
  assert.deepEqual(devInput.problemsReported.map((p) => [p.reportedBy, p.title]), [['PO', 'Centre the phrase on the page']]);
  // QA verified the rework again, and the PO re-reviewed it knowing its earlier reasons.
  assert.equal(events.filter((e) => e.type === 'test.results').length, 2);
  assert.deepEqual(JSON.parse(received[4].stdin).yourPreviousRejections[0].reasons, ['Centre the phrase on the page']);

  const analytics = computeAnalytics(app.repository.analyticsSource(), {}, { agents: [] });
  assert.match(analytics.kpis.find((k) => k.key === 'corrections').detail, /0 from QA · 1 from the PO/);
});

test('the AI PO cannot accept what QA did not verify, and a rejection with no attempts left fails', async (t) => {
  const reject = { content: { decision: 'reject', summary: 'Not accepted: still not centred.', reasons: [{ text: 'Centre it', origin: 'implementation' }] } };
  const { app, claude } = await aiApp(t, [{ content: PO_SPEC }, { content: page('red') }, reject, { content: page('red') }, reject, { content: page('red') }, reject]);
  const { workflow } = await run(app);
  assert.equal(workflow.status, 'failed', 'three implementations, then the limit');
  assert.equal(workflow.state.attempt, 3);
  assert.equal(workflow.verified, false);
  assert.equal(workflow.state.verification.verdict, 'pass', 'QA still records that its tests passed');

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

test('the PO must ask before deciding: refinement rules in the contract', () => {
  const ready = (extra) => ({ status: 'ready', title: 'Game', requirements: ['r'], acceptanceCriteria: [{ description: 'd', check: { type: 'centeredLayout' } }], ...extra });
  // No assumptions list at all: refused.
  assert.throws(() => validatePoReply(ready({})), /"assumptions" is required/);
  // First round: deciding something the user never said is refused; so is skipping the questions without a reason.
  assert.throws(() => validatePoReply(ready({ assumptions: [{ text: 'Breakout with 5 rows', decidedBy: 'po' }], whyNoQuestions: 'x' }), { firstRound: true }), /ask instead of deciding/);
  assert.throws(() => validatePoReply(ready({ assumptions: [] }), { firstRound: true }), /whyNoQuestions/);
  assert.equal(validatePoReply(ready({ assumptions: [], whyNoQuestions: 'Everything is specified.' }), { firstRound: true }).status, 'ready');
  // After the user answered ("you decide"), the PO may decide, and it is recorded as such.
  const later = validatePoReply(ready({ assumptions: [{ text: 'Breakout with 5 rows', decidedBy: 'po' }] }), { firstRound: false });
  assert.deepEqual(later.assumptions, [{ text: 'Breakout with 5 rows', decidedBy: 'po' }]);

  // Questions are structured and numbered for the user.
  const asked = validatePoReply({
    status: 'needs_clarification',
    questions: [{ question: 'Which game?', why: 'It decides everything else', options: ['Breakout', 'Snake'] }, { question: 'Keyboard or mouse?' }],
  });
  assert.equal(asked.questions.length, 2);
  assert.equal(asked.message, 'Before I write the requirements, I need to know:\n1. Which game? (Breakout / Snake)\n2. Keyboard or mouse?');
  assert.throws(() => validatePoReply({ status: 'needs_clarification', questions: [] }), /"questions"/);
});

test('a PO that decides on its own is sent back and asks instead', async (t) => {
  const guessed = { content: { ...PO_SPEC, assumptions: [{ text: 'A Breakout clone with 5 rows of bricks', decidedBy: 'po' }] } };
  const asks = { content: { status: 'needs_clarification', reason: 'ambiguous', questions: [{ question: 'Which game?', why: 'Rules and controls depend on it', options: ['Breakout', 'Snake'] }, { question: 'How does the game end?' }] } };
  const { app, claude } = await aiApp(t, [guessed, asks]);
  const { workflow, events } = await run(app, 'build a game');
  assert.equal(workflow.status, 'needs_clarification');
  const received = await claude.received();
  assert.match(received[1].stdin, /ask instead of deciding/);
  const question = events.find((e) => e.type === 'po.clarification');
  assert.deepEqual(question.detail.questions.map((q) => q.question), ['Which game?', 'How does the game end?']);
  assert.equal(question.detail.round, 1);
  assert.match(workflow.state.clarification.message, /1\. Which game\? \(Breakout \/ Snake\)\n2\. How does the game end\?/);
  const { process: p } = computeAnalytics(app.repository.analyticsSource(), {}, { agents: [] });
  assert.equal(p.po.find((m) => m.key === 'poGuessesStopped').value, 1, 'the guess was stopped and counted');
  assert.equal(p.po.find((m) => m.key === 'poRefused').value, 1);
});

// QA (AI) tests as the model would write them.
const qaTests = (body, concerns = []) => ({
  content: {
    summary: 'Checks the phrase and colours from the request.',
    concerns,
    testFile: `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\n${body}\n`,
  },
});
const PASSING_QA = qaTests(`test('QA-AI: the page says hello world', () => {\n  assert.match(readFileSync('index.html', 'utf8'), /hello world/);\n});`);

test('an AI-powered QA runs the deterministic checks and its own tests, read-only', async (t) => {
  const { app, claude } = await aiApp(t, [{ content: PO_SPEC }, { content: page('red') }, PASSING_QA, ACCEPT], { qaMode: 'ai' });
  const { workflow, events } = await run(app);
  assert.equal(workflow.status, 'completed');
  assert.equal(workflow.verified, true);

  // QA's request carried the user's own words, the dialogue and the product files.
  const received = await claude.received();
  const qaInput = JSON.parse(received[2].stdin);
  assert.match(qaInput.request, /background green and font red/);
  assert.ok(qaInput.files.some((f) => f.path === 'style.css'));
  assert.ok(!qaInput.files.some((f) => f.path.startsWith('test/') || f.path.startsWith('qa/')));

  // Both suites really ran; the AI tests under the permission model.
  assert.equal(events.find((e) => e.type === 'test.results').detail.summary.pass, 5, 'the deterministic acceptance tests');
  assert.equal(events.find((e) => e.type === 'qa.ai-tests').detail.summary.pass, 1);
  const command = events.find((e) => e.type === 'command.started' && e.detail.command.includes('ai-checks'));
  assert.match(command.detail.command, /^node --permission --allow-fs-read=\S+ --test-reporter=tap qa\/ai-checks\.mjs$/);
  assert.equal(events.find((e) => e.type === 'qa.verdict').actorKind, 'ai');
  assert.equal(workflow.state.verification.aiTests.pass, 1);
});

test("QA (AI) test failures become defects for the Developer; QA's concerns reach the PO", async (t) => {
  const strict = qaTests(
    `test('QA-AI: the phrase is red', () => {\n  assert.match(readFileSync('style.css', 'utf8'), /p \\{ color: red/);\n});`,
    ['The request says "font red": the requirements only colour the phrase, not all text.'],
  );
  const acceptWithAnswer = { content: { ...ACCEPT.content, concernResponses: [{ concern: 1, decision: 'disagree', reason: 'The user asked for the phrase in red; the page has no other text.' }] } };
  const { app, claude } = await aiApp(t, [{ content: PO_SPEC }, { content: page('blue') }, strict, { content: page('red') }, strict, acceptWithAnswer], { qaMode: 'ai' });
  const { workflow, events } = await run(app);
  assert.equal(workflow.status, 'completed');
  const defects = events.filter((e) => e.type === 'defect.reported');
  assert.ok(defects.some((d) => d.detail.reportedBy === 'QA (AI test)' && /QA-AI: the phrase is red failed/.test(d.summary)));
  const concern = events.find((e) => e.type === 'qa.concern');
  assert.equal(concern.from, 'qa');
  assert.equal(concern.to, 'po');
  const received = await claude.received();
  assert.deepEqual(JSON.parse(received.at(-1).stdin).qaVerification.qaConcerns, ['The request says "font red": the requirements only colour the phrase, not all text.']);
  // The PO answered the concern explicitly, and every defect says where it comes from.
  const review = events.find((e) => e.type === 'po.review');
  assert.deepEqual(review.detail.concernResponses.map((r) => r.decision), ['disagree']);
  assert.ok(defects.every((d) => ['implementation', 'requirements'].includes(d.detail.origin)));
  const { process: p } = computeAnalytics(app.repository.analyticsSource(), {}, { agents: [] });
  const poConcerns = p.po.find((m) => m.key === 'poConcerns');
  assert.equal(poConcerns.value, 0);
  assert.match(poConcerns.detail, /of 2 answered · 2 dismissed|of 1 answered · 1 dismissed/);
  assert.ok(p.dev.find((m) => m.key === 'devCodeDefects').value >= 1);

  // The concerns export pairs each concern with the PO's answer; the one raised
  // on the delivery that went back to the Developer was never reviewed.
  const csv = await (await fetch(`${app.url}/api/analytics/export/concerns.csv`)).text();
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'request id,product,kind,request,raised at,QA concern,PO decision,PO reason,answered at');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /,not answered,,$/);
  assert.match(lines[2], /,disagree,The user asked for the phrase in red; the page has no other text\.,\d{4}-/);
});

test('AI-written tests cannot write files or start processes, and a broken file never counts against the product', async (t) => {
  const escape = qaTests(`import { writeFileSync } from 'node:fs';\ntest('QA-AI: tries to write', () => {\n  writeFileSync('owned.txt', 'x');\n});`);
  const { app } = await aiApp(t, [{ content: PO_SPEC }, { content: page('red') }, escape, { content: page('red') }, PASSING_QA, ACCEPT], { qaMode: 'ai' });
  const { workflow, events } = await run(app);
  // The write was refused by Node: the test failed, nothing was written.
  const ai = events.find((e) => e.type === 'qa.ai-tests');
  assert.equal(ai.detail.summary.fail, 1);
  assert.match(ai.detail.tests[0].error, /ERR_ACCESS_DENIED|Access to this API has been restricted/);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(app.orchestrator.productDir(workflow.id), 'owned.txt')), false);
  assert.equal(workflow.status, 'completed', 'the next round passed');

  // Disallowed modules are refused before anything runs.
  const { validateQaReply } = await import('../src/ai/contracts.js');
  assert.throws(() => validateQaReply({ testFile: "import { exec } from 'node:child_process';\ntest('QA-AI: x', () => {});" }), /Not allowed: node:child_process/);
  assert.throws(() => validateQaReply({ testFile: "test('QA-AI: x', () => { fetch('http://x') });" }), /network/);
  assert.throws(() => validateQaReply({ testFile: "test('QA-AI: x', () => { if ( });" }), /does not parse/);
});

test("a QA (AI) test file that crashes is QA's problem: the deterministic checks decide", async (t) => {
  const broken = qaTests(`throw new Error('QA forgot something');\ntest('QA-AI: never runs', () => {});`);
  const { app } = await aiApp(t, [{ content: PO_SPEC }, { content: page('red') }, broken, ACCEPT], { qaMode: 'ai' });
  const { workflow, events } = await run(app);
  assert.equal(workflow.status, 'completed', 'not blamed on the Developer');
  const warning = events.find((e) => e.type === 'qa.ai-tests-failed');
  assert.match(warning.error, /QA forgot something/);
  assert.ok(!events.some((e) => e.type === 'defect.reported'));
});

test('team process statistics: PO questions one by one, Developer mistakes caught by QA, work sent back by the PO', async (t) => {
  const asks = { content: { status: 'needs_clarification', reason: 'ambiguous', questions: [{ question: 'Which phrase?' }, { question: 'Which colours?' }, { question: 'Centred?' }] } };
  const reject = { content: { decision: 'reject', summary: 'Not accepted: not centred enough.', reasons: [{ text: 'Centre it', origin: 'implementation' }] } };
  const { app } = await aiApp(t, [asks, { content: PO_SPEC }, { content: page('blue') }, { content: page('red') }, reject, { content: page('red') }, ACCEPT]);
  const { workflow } = await run(app, 'make me a page');
  assert.equal(workflow.status, 'needs_clarification');
  const done = await app.orchestrator.answer(workflow.id, 'hello world, green and red, centred').done;
  assert.equal(done.status, 'completed');

  const { process: p } = computeAnalytics(app.repository.analyticsSource(), {}, { agents: [] });
  const value = (list, key) => list.find((m) => m.key === key);
  assert.equal(value(p.po, 'poInterruptionsCount').value, 1, 'one interruption…');
  assert.equal(value(p.po, 'poQuestionsCount').value, 3, '…with three questions asked at once');
  assert.equal(value(p.po, 'poAnswers').value, 1);
  assert.equal(value(p.po, 'poAssumptions').value, 1, 'one assumption written down…');
  assert.equal(value(p.po, 'poNoQuestions').value, 0, 'it asked, so it did not go ahead without asking');
  assert.equal(value(p.po, 'poAssumptions').detail, '1 from your answers · 0 decided by the PO');
  assert.equal(value(p.po, 'poRejected').value, 1);
  assert.equal(value(p.dev, 'devDeliveries').value, 3, 'first build, QA correction, PO rework');
  assert.equal(value(p.dev, 'devCaughtByQa').value, 1);
  assert.equal(value(p.dev, 'devSentBackByPo').value, 1);
  assert.equal(value(p.dev, 'devFirstTimeRight').value, 0);
  assert.equal(value(p.qa, 'qaVerifications').value, 3);
  assert.equal(value(p.qa, 'qaDefects').value, 1);
  assert.equal(value(p.qa, 'qaMissed').value, 1);
});

test('the PO must answer every QA concern and give the origin of every rejection reason', async () => {
  const { validateReviewReply } = await import('../src/ai/contracts.js');
  const concerns = ['The score position is not in the requirements.'];
  assert.throws(() => validateReviewReply({ decision: 'accept', summary: 'ok' }, { qaPassed: true, concerns }), /Answer QA's concern 1/);
  assert.throws(() => validateReviewReply({ decision: 'reject', summary: 'no', reasons: ['Move the score'] }, { qaPassed: true }), /"origin":"requirements" \| "implementation"/);
  const ok = validateReviewReply(
    { decision: 'reject', summary: 'no', reasons: [{ text: 'The score must be top right', origin: 'requirements' }], concernResponses: [{ concern: 1, decision: 'agree', reason: 'The user said top right.' }] },
    { qaPassed: true, concerns },
  );
  assert.deepEqual(ok.reasonOrigins, ['requirements']);
  assert.deepEqual(ok.concernResponses, [{ concern: concerns[0], decision: 'agree', reason: 'The user said top right.' }]);
});

test('each agent can use its own model; requests record the models and Analytics compares setups', async (t) => {
  const { app, claude } = await aiApp(t, [{ content: PO_SPEC }, { content: page('red') }, ACCEPT, { content: PO_SPEC }, { content: page('red') }, ACCEPT]);
  assert.equal((await fetch(`${app.url}/api/agents/dev`, json('PUT', { model: 'opus; rm -rf /' }))).status, 400);
  assert.equal((await fetch(`${app.url}/api/agents/dev`, json('PUT', { model: 'opus' }))).status, 200);
  const state = await (await fetch(`${app.url}/api/state`)).json();
  assert.deepEqual(state.agents.map((a) => [a.id, a.model]), [['po', null], ['dev', 'opus'], ['qa', null]]);
  assert.match(app.repository.listWorkspaceEvents().find((e) => e.type === 'agent.model').summary, /Developer now uses the model "opus"/);

  const { workflow: first } = await run(app);
  // Back to the workspace default for the second request.
  await fetch(`${app.url}/api/agents/dev`, json('PUT', { model: '' }));
  await run(app);

  const received = await claude.received();
  assert.deepEqual(received.map((r) => option(r.args, '--model')), ['sonnet', 'opus', 'sonnet', 'sonnet', 'sonnet', 'sonnet'], 'PO, Developer, PO review per request');
  const created = app.repository.listEvents(first.id).find((e) => e.type === 'workflow.created');
  assert.deepEqual(created.detail.team.map((a) => [a.id, a.model]), [['po', 'sonnet'], ['dev', 'opus'], ['qa', null]]);

  const { modelComparison } = computeAnalytics(app.repository.analyticsSource(), {}, { agents: [] });
  assert.deepEqual(
    modelComparison.map((g) => [g.models.po, g.models.dev, g.models.qa, g.requests, g.aiRequestsPerRequest]).sort(),
    [['claude-sonnet-test', 'claude-opus-test', 'scripted', 1, 3], ['claude-sonnet-test', 'claude-sonnet-test', 'scripted', 1, 3]].sort(),
  );
});

test('coming back with a bug: the PO traces its origin, and Analytics counts bugs that got past the team', async (t) => {
  const bugSpec = { content: { ...PO_SPEC, changes: ['Added: AC for the fix'], bugOrigin: 'implementation' } };
  const noOrigin = { content: { ...PO_SPEC, changes: [] } };
  const { app, claude } = await aiApp(t, [
    { content: PO_SPEC }, { content: page('red') }, ACCEPT, // v1, verified
    noOrigin, bugSpec, { content: page('red') }, ACCEPT, // bug report: first answer lacks the origin
    { content: PO_SPEC }, { content: page('red') }, ACCEPT, // change request
  ]);
  const { workflow: first } = await run(app);
  assert.equal((await fetch(`${app.url}/api/workflows`, json('POST', { request: 'a bug', type: 'oops', productId: first.productId }))).status, 400);
  assert.throws(() => app.orchestrator.submit('a bug', { type: 'bug' }), /needs the product it is about/);

  const bug = await app.orchestrator.submit('The phrase is not centred on small screens', { productId: first.productId, type: 'bug' }).done;
  assert.equal(bug.status, 'completed');
  assert.equal(bug.state.requestType, 'bug');
  assert.equal(bug.state.spec.bugOrigin, 'implementation');
  const received = await claude.received();
  const poInput = JSON.parse(received[3].stdin);
  assert.equal(poInput.bugReport, 'The phrase is not centred on small screens');
  assert.match(option(received[3].args, '--system-prompt'), /BUG REPORT/);
  assert.match(received[4].stdin, /bugOrigin/, 'the answer without an origin was sent back');
  assert.match(app.repository.listEvents(bug.id).find((e) => e.type === 'request.submitted').summary, /^Bug report for/);

  await app.orchestrator.submit('Make the text blue', { productId: first.productId, type: 'change' }).done;

  const data = computeAnalytics(app.repository.analyticsSource(), {}, { agents: [] });
  const kpi = (key) => data.kpis.find((k) => k.key === key);
  assert.equal(kpi('bugsReported').value, 1);
  assert.match(kpi('bugsReported').detail, /^1 after a delivery QA had verified · origin: 0 requirements, 1 code$/);
  assert.equal(kpi('changeRequests').value, 1);
  assert.equal(data.process.qa.find((m) => m.key === 'qaEscaped').value, 1);
  assert.equal(data.process.dev.find((m) => m.key === 'devBugsCode').value, 1);
  const setup = data.modelComparison[0];
  assert.equal(setup.bugsPerDelivery, 1 / 3, 'one bug found later, three verified deliveries');

  const state = await (await fetch(`${app.url}/api/state`)).json();
  assert.deepEqual(state.workflows.map((w) => w.requestType).sort(), ['bug', 'change', null].sort());
});

test('PO contract: a product of many versions fits, and the error says what is wrong', () => {
  const crit = (n) => Array.from({ length: n }, (_, i) => ({ description: `c${i}`, check: { type: 'fileExists', path: 'index.html' } }));
  const reply = (n, c = 1) => ({ status: 'ready', title: 'Game', requirements: Array.from({ length: n }, (_, i) => `r${i}`), acceptanceCriteria: crit(c), assumptions: [] });
  assert.equal(validatePoReply(reply(20, 15), { firstRound: false }).requirements.length, 20);
  assert.throws(() => validatePoReply(reply(41), { firstRound: false }), /1–40 strings \(it has 41\)/);
  assert.throws(() => validatePoReply({ ...reply(1), requirements: ['x'.repeat(1001)] }, { firstRound: false }), /requirements\[0\] must be a non-empty string of at most 1000/);
});

// ---- Team rules v2: the Developer and QA ask the PO ----

const DEV_ASKS = { content: { status: 'questions', questions: [{ question: 'Which font should the phrase use?', why: 'The requirements give no font.' }] } };
const PO_ANSWERS = { content: { answers: [{ question: 1, answer: 'Use the default sans-serif font.' }] } };

test('the Developer asks the PO before coding; the answer reaches the Developer and the review; it can ask only once', async (t) => {
  const { app, claude } = await aiApp(t, [{ content: PO_SPEC }, DEV_ASKS, PO_ANSWERS, DEV_ASKS, { content: page('red') }, ACCEPT]);
  const { workflow, events } = await run(app);
  assert.equal(workflow.status, 'completed');
  assert.deepEqual(workflow.state.rules, { version: 2 });

  const question = events.find((e) => e.type === 'team.question');
  assert.equal(question.actor, 'dev');
  assert.equal(question.to, 'po');
  assert.equal(question.detail.questions[0].question, 'Which font should the phrase use?');
  const answer = events.find((e) => e.type === 'team.answer');
  assert.equal(answer.actor, 'po');
  assert.equal(answer.to, 'dev');
  assert.deepEqual(answer.detail.answers, [{ question: 'Which font should the phrase use?', answer: 'Use the default sans-serif font.' }]);

  const received = await claude.received();
  assert.match(option(received[1].args, '--system-prompt'), /You may ask the PO questions before you write the code/);
  assert.match(option(received[2].args, '--system-prompt'), /Product Owner[\s\S]*The Developer asked you questions/);
  const devAgain = JSON.parse(received[3].stdin.slice(received[3].stdin.indexOf('{')));
  assert.deepEqual(devAgain.teamClarifications, [{ askedBy: 'Developer', question: 'Which font should the phrase use?', answer: 'Use the default sans-serif font.', answeredBy: 'the PO' }]);
  assert.match(option(received[3].args, '--system-prompt'), /do not ask again/);
  // Asking a second time is refused: the Developer had to deliver.
  assert.match(received[4].stdin, /You already asked your questions/);
  assert.equal(JSON.parse(received[5].stdin).teamClarifications.length, 1, 'the PO review sees the answers too');

  const { process: p } = computeAnalytics(app.repository.analyticsSource(), {}, { agents: [] });
  const value = (list, key) => list.find((m) => m.key === key);
  assert.equal(value(p.dev, 'devQuestions').value, 1);
  assert.equal(value(p.dev, 'devQuestions').detail, '1 time it stopped · 1 answered by the PO · 0 passed on to you');
  assert.equal(value(p.po, 'poTeamAnswered').value, 1);
  assert.equal(value(p.dev, 'devRefused').value, 1, 'the second question round was refused');
  const csv = requestsCsv(app.repository.analyticsSource(), {});
  const [header, row] = csv.replace(/^﻿/, '').trim().split('\r\n');
  const col = (name) => row.split(',')[header.split(',').indexOf(name)];
  assert.equal(col('team rules'), 'v2');
  assert.equal(col('Developer questions'), '1');
  assert.equal(col('team questions answered by the PO'), '1');
});

test('QA asks the PO; what only the user can decide is passed on to the user, and the work continues', async (t) => {
  const qaAsks = { content: { status: 'questions', questions: [{ question: 'Must the phrase stay centred on small screens too?', why: 'It decides which sizes I test.' }] } };
  const poPassesOn = { content: { answers: [{ question: 1, askUser: true, why: 'The user never said which screens matter.' }] } };
  const { app, claude } = await aiApp(t, [{ content: PO_SPEC }, { content: page('red') }, qaAsks, poPassesOn, PASSING_QA, ACCEPT], { qaMode: 'ai' });
  const { workflow, events } = await run(app);
  assert.equal(workflow.status, 'needs_clarification');
  assert.equal(workflow.state.waitingFor, 'team');
  const escalation = events.find((e) => e.type === 'po.escalation');
  assert.equal(escalation.to, 'user');
  assert.equal(escalation.detail.for, 'qa');
  assert.equal(escalation.detail.questions[0].poWhy, 'The user never said which screens matter.');
  const state = await (await fetch(`${app.url}/api/state`)).json();
  assert.equal(state.workflows.find((w) => w.id === workflow.id).waitingFor, 'team');

  const done = await app.orchestrator.answer(workflow.id, 'Yes, on phones too.').done;
  assert.equal(done.status, 'completed');
  const answered = app.repository.listEvents(workflow.id).find((e) => e.type === 'team.answered');
  assert.equal(answered.to, 'qa');
  const received = await claude.received();
  assert.deepEqual(JSON.parse(received[4].stdin).teamClarifications, [{ askedBy: 'QA', question: 'Must the phrase stay centred on small screens too?', answer: 'Yes, on phones too.', answeredBy: 'the user' }]);

  const { process: p } = computeAnalytics(app.repository.analyticsSource(), {}, { agents: [] });
  assert.equal(p.qa.find((m) => m.key === 'qaQuestions').detail, '1 time it stopped · 0 answered by the PO · 1 passed on to you');
  assert.equal(p.po.find((m) => m.key === 'poTeamAnswered').detail, '1 passed on to you');
  assert.equal(p.po.find((m) => m.key === 'poAnswers').value, 0, 'an answer to a teammate is not an answer to the PO');
});

test('contracts: questions only once; the PO answers every question or passes it on with a reason; a scripted PO passes everything on', () => {
  const ask = { status: 'questions', questions: [{ question: 'Which font?' }] };
  assert.deepEqual(validateDevReply(ask, { canAsk: true }), { status: 'questions', questions: [{ question: 'Which font?', why: null }] });
  assert.throws(() => validateDevReply(ask, { canAsk: false }), /already asked/);
  assert.throws(() => validateDevReply({ status: 'questions', questions: [] }, { canAsk: true }), /1–5 items/);
  assert.throws(() => validateTeamAnswerReply({ answers: [{ question: 1, answer: 'x' }] }, { count: 2 }), /Answer question 2/);
  assert.throws(() => validateTeamAnswerReply({ answers: [{ question: 1, askUser: true }] }, { count: 1 }), /why only the user can decide/);
  assert.deepEqual(validateTeamAnswerReply({ answers: [{ question: 1, askUser: true, why: 'Taste.' }] }, { count: 1 }).answers, [{ question: 1, answer: null, askUser: true, why: 'Taste.' }]);
  const scripted = new ProductOwnerAgent().answerTeam({ questions: [{ question: 'a' }, { question: 'b' }] });
  assert.ok(scripted.answers.every((a) => a.askUser));
});

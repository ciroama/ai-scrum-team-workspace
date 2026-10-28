import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server/app.js';
import { tempDir } from './helpers.js';

async function start(t) {
  const app = await startServer({ port: 0, dataDir: await tempDir(t) });
  t.after(() => app.close());
  return app;
}

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Collects server-sent workflow events until `until(event)` is true. */
async function collect(url, until) {
  const controller = new AbortController();
  const res = await fetch(`${url}/api/stream`, { signal: controller.signal });
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  const finished = (async () => {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (!frame.startsWith('event: workflow-event')) continue;
        const event = JSON.parse(frame.split('\ndata: ')[1]);
        events.push(event);
        if (until(event)) {
          controller.abort();
          return events;
        }
      }
    }
    return events;
  })().catch((error) => {
    if (error.name === 'AbortError') return events;
    throw error;
  });
  return finished;
}

test('serves the dashboard and its scripts, and refuses paths outside public/', async (t) => {
  const { url } = await start(t);
  for (const path of ['/', '/styles.css', '/js/app.js', '/js/workspace.js', '/js/views.js', '/js/dom.js', '/favicon.svg']) {
    assert.equal((await fetch(url + path)).status, 200, path);
  }
  const html = await (await fetch(url)).text();
  assert.match(html, /AI Scrum Team/);
  assert.equal((await fetch(`${url}/..%2Fpackage.json`)).status, 404);
  assert.equal((await fetch(`${url}/nope.js`)).status, 404);
});

test('state describes the three scripted agents and the supported request types', async (t) => {
  const { url } = await start(t);
  const state = await (await fetch(`${url}/api/state`)).json();
  assert.deepEqual(state.agents.map((a) => `${a.label}:${a.kind}:${a.enabled}:${a.execution}`), [
    'PO:scripted:true:idle',
    'Developer:scripted:true:idle',
    'QA:scripted:true:idle',
  ]);
  assert.deepEqual(state.recipes.map((r) => r.title), ['Hello World web application']);
  assert.equal(state.focusWorkflowId, null);
});

test('submitting a requirement runs a workflow with live events and inspectable results', async (t) => {
  const { url } = await start(t);
  const streamed = collect(url, (e) => e.type === 'workflow.completed' || e.type === 'workflow.failed');

  const res = await fetch(`${url}/api/workflows`, json('POST', { request: 'Build a simple Hello World web application.' }));
  assert.equal(res.status, 201);
  const { workflow } = await res.json();

  // A duplicate submission while it runs is refused.
  const dup = await fetch(`${url}/api/workflows`, json('POST', { request: 'Build a Hello World application' }));
  assert.equal(dup.status, 409);

  const events = await streamed;
  assert.equal(events.at(-1).type, 'workflow.completed');

  const detail = await (await fetch(`${url}/api/workflows/${workflow.id}`)).json();
  assert.equal(detail.workflow.status, 'completed');
  assert.equal(detail.workflow.verified, true);
  assert.ok(detail.events.length >= events.length);
  const paths = detail.product.files.map((f) => f.path);
  for (const file of ['index.html', 'app.js', 'src/greet.js', 'README.md']) assert.ok(paths.includes(file), file);
  assert.ok(!paths.some((p) => p.startsWith('.git')));
});

test('agents can be toggled over the API and the change is reflected in state', async (t) => {
  const { url } = await start(t);
  assert.equal((await fetch(`${url}/api/agents/qa`, json('PUT', { enabled: false }))).status, 200);
  const state = await (await fetch(`${url}/api/state`)).json();
  assert.equal(state.agents.find((a) => a.id === 'qa').enabled, false);
  assert.equal((await fetch(`${url}/api/agents/pm`, json('PUT', { enabled: false }))).status, 404);
  assert.equal((await fetch(`${url}/api/agents/qa`, json('PUT', { enabled: 'yes' }))).status, 400);
});

test('blocked workflows can be resumed over the API once the agent is enabled', async (t) => {
  const { url, orchestrator } = await start(t);
  await fetch(`${url}/api/agents/dev`, json('PUT', { enabled: false }));
  const { workflow } = await (await fetch(`${url}/api/workflows`, json('POST', { request: 'Build a Hello World application' }))).json();
  await orchestrator.current?.promise;

  const refused = await fetch(`${url}/api/workflows/${workflow.id}/resume`, { method: 'POST' });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /Developer is still disabled/);

  await fetch(`${url}/api/agents/dev`, json('PUT', { enabled: true }));
  assert.equal((await fetch(`${url}/api/workflows/${workflow.id}/resume`, { method: 'POST' })).status, 200);
  await orchestrator.current?.promise;
  const detail = await (await fetch(`${url}/api/workflows/${workflow.id}`)).json();
  assert.equal(detail.workflow.status, 'completed');
});

test('invalid input gets clear errors', async (t) => {
  const { url } = await start(t);
  const empty = await fetch(`${url}/api/workflows`, json('POST', { request: '' }));
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /describe what you would like to build/);
  const bad = await fetch(`${url}/api/workflows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${url}/api/workflows/nope`)).status, 404);
  assert.equal((await fetch(`${url}/api/nope`)).status, 404);
});

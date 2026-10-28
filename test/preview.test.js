import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../src/server/app.js';
import { tempDir } from './helpers.js';

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function start(t, options = {}) {
  const app = await startServer({ port: 0, dataDir: await tempDir(t), ...options });
  t.after(() => app.close());
  return app;
}

async function buildProduct(app, request = 'Build a simple Hello World web application.') {
  const { workflow, done } = app.orchestrator.submit(request);
  await done;
  return workflow.id;
}

test('the preview starts as Not Started', async (t) => {
  const { url } = await start(t);
  const status = await (await fetch(`${url}/api/preview`)).json();
  assert.equal(status.status, 'not_started');
  assert.equal(status.url, null);
});

test('serves the real generated Hello World page of the selected workflow', async (t) => {
  const app = await start(t);
  const id = await buildProduct(app);

  const status = await (await fetch(`${app.url}/api/preview`, json('POST', { workflowId: id }))).json();
  assert.equal(status.status, 'running');
  assert.equal(status.workflowId, id);
  assert.match(status.url, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/${id}/index\\.html$`));
  assert.notEqual(new URL(status.url).port, new URL(app.url).port, 'separate server, separate port');

  // Byte-for-byte the file the Developer wrote.
  const page = await (await fetch(status.url)).text();
  assert.equal(page, readFileSync(join(app.orchestrator.productDir(id), 'index.html'), 'utf8'));
  assert.match(page, /<title>Hello World<\/title>/);
  const script = await fetch(new URL('src/greet.js', status.url));
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);

  // Hidden files (the product's .git) and paths outside the product are never served.
  const base = new URL(status.url);
  assert.equal((await fetch(`${base.origin}/${id}/.git/config`)).status, 404);
  assert.equal((await fetch(`${base.origin}/${id}/..%2F..%2Fworkspace.db`)).status, 404);
});

test('starting twice reuses the server; another workflow switches it and the old URL stops working', async (t) => {
  const app = await start(t);
  const first = await buildProduct(app);
  const second = await buildProduct(app, 'Build a Hello World application');

  const a = await (await fetch(`${app.url}/api/preview`, json('POST', { workflowId: first }))).json();
  const [b, c] = await Promise.all([
    fetch(`${app.url}/api/preview`, json('POST', { workflowId: first })).then((r) => r.json()),
    fetch(`${app.url}/api/preview`, json('POST', { workflowId: first })).then((r) => r.json()),
  ]);
  assert.equal(b.port, a.port);
  assert.equal(c.port, a.port);

  const d = await (await fetch(`${app.url}/api/preview`, json('POST', { workflowId: second }))).json();
  assert.equal(d.status, 'running');
  assert.equal(d.port, a.port, 'still one preview server');
  assert.equal(d.workflowId, second);
  assert.equal((await fetch(a.url)).status, 404, 'the previous product is no longer served');
  assert.equal((await fetch(d.url)).status, 200);
});

test('reports a clear error when the workflow has no product', async (t) => {
  const app = await start(t);
  const id = await buildProduct(app, 'Build a futuristic Breakout game');
  const status = await (await fetch(`${app.url}/api/preview`, json('POST', { workflowId: id }))).json();
  assert.equal(status.status, 'error');
  assert.match(status.error, /no product yet/);
  assert.equal(status.url, null);

  const missing = await (await fetch(`${app.url}/api/preview`, json('POST', { workflowId: 'wf-does-not-exist' }))).json();
  assert.equal(missing.status, 'error');
  assert.match(missing.error, /does not exist/);
});

test('reports an error, not running, when the product files disappear', async (t) => {
  const app = await start(t);
  const id = await buildProduct(app);
  await fetch(`${app.url}/api/preview`, json('POST', { workflowId: id }));
  rmSync(join(app.orchestrator.productDir(id), 'index.html'));

  const status = await (await fetch(`${app.url}/api/preview/refresh`, { method: 'POST' })).json();
  assert.equal(status.status, 'error');
  assert.match(status.error, /index\.html/);
});

test('reports a startup error when the preview port is unavailable', async (t) => {
  const blocker = createServer(() => {});
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const busyPort = blocker.address().port;

  const app = await start(t, { previewPort: busyPort });
  const id = await buildProduct(app);
  const status = await (await fetch(`${app.url}/api/preview`, json('POST', { workflowId: id }))).json();
  assert.equal(status.status, 'error');
  assert.match(status.error, /could not start/);
  assert.match(status.error, /EADDRINUSE/);
});

test('stop returns the preview to Not Started and frees the port', async (t) => {
  const app = await start(t);
  const id = await buildProduct(app);
  const running = await (await fetch(`${app.url}/api/preview`, json('POST', { workflowId: id }))).json();
  const stopped = await (await fetch(`${app.url}/api/preview/stop`, { method: 'POST' })).json();
  assert.equal(stopped.status, 'not_started');
  await assert.rejects(fetch(running.url));
});

test('rejects a preview request without a workflow', async (t) => {
  const { url } = await start(t);
  assert.equal((await fetch(`${url}/api/preview`, json('POST', {}))).status, 400);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server/app.js';
import { tempDir } from './helpers.js';

async function start(t) {
  const app = await startServer({ port: 0, dataDir: await tempDir(t) });
  t.after(() => app.close());
  return app;
}

/** Collects server-sent 'execution' events until `until(event)` is true. */
async function collectStream(url, until) {
  const controller = new AbortController();
  const res = await fetch(`${url}/api/stream`, { signal: controller.signal });
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  const finished = (async () => {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (!frame.startsWith('event: execution')) continue;
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
  return { finished };
}

test('serves the dashboard and its assets', async (t) => {
  const { url } = await start(t);
  for (const [path, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/styles.css', 'text/css']]) {
    const res = await fetch(url + path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), new RegExp(type));
  }
  const html = await (await fetch(url)).text();
  assert.match(html, /AI Scrum Team Workspace/);
  assert.match(html, /Scripted/);
});

test('state lists the PO, Dev and QA scripted agents and the seeded story', async (t) => {
  const { url } = await start(t);
  const state = await (await fetch(`${url}/api/state`)).json();
  assert.deepEqual(state.team.map((a) => `${a.name}:${a.kind}`), ['PO:scripted', 'Dev:scripted', 'QA:scripted']);
  assert.equal(state.stories[0].workflow, 'hello-world');
  assert.deepEqual(state.runs, []);
});

test('starting a run streams live events and exposes results, events and files', async (t) => {
  const { url } = await start(t);
  const stream = await collectStream(url, (e) => e.type === 'run.completed');

  const res = await fetch(`${url}/api/stories/story-hello-world/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'standard' }),
  });
  assert.equal(res.status, 202);
  const { run } = await res.json();

  const streamed = await stream.finished;
  assert.equal(streamed.at(-1).payload.status, 'passed');
  assert.ok(streamed.every((e) => e.runId === run.id));

  const detail = await (await fetch(`${url}/api/runs/${run.id}`)).json();
  assert.equal(detail.run.status, 'passed');
  assert.equal(detail.events.length, streamed.length, 'stored events match streamed events');

  const { files } = await (await fetch(`${url}/api/runs/${run.id}/files`)).json();
  assert.deepEqual(files.map((f) => f.path).sort(), ['ACCEPTANCE.md', 'hello.js', 'hello.test.js', 'package.json']);
});

test('rejects unknown run modes and unknown stories', async (t) => {
  const { url } = await start(t);
  const post = (story, body) =>
    fetch(`${url}/api/stories/${story}/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('story-hello-world', { mode: 'chaos' })).status, 400);
  assert.equal((await post('nope', {})).status, 404);
  assert.equal((await fetch(`${url}/api/runs/nope`)).status, 404);
});

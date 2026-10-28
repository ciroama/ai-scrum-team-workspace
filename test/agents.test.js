import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeam } from '../src/agents/team.js';
import { AgentKind } from '../src/agents/agent.js';
import { ProductOwnerAgent } from '../src/agents/productOwner.js';
import { QaAgent, generateAcceptanceTests } from '../src/agents/qa.js';
import { RECIPES, normalizeRequest } from '../src/recipes/index.js';
import { STAGES } from '../src/core/stages.js';

const po = new ProductOwnerAgent();
const analyse = (requestText) => po.analyse({ requestText, recipes: RECIPES });

test('the team is exactly PO, Developer and QA, all scripted', () => {
  const team = createTeam();
  assert.deepEqual([...team.values()].map((a) => [a.id, a.label, a.kind]), [
    ['po', 'PO', AgentKind.SCRIPTED],
    ['dev', 'Developer', AgentKind.SCRIPTED],
    ['qa', 'QA', AgentKind.SCRIPTED],
  ]);
  for (const stage of Object.values(STAGES)) assert.ok(team.has(stage.agent), `${stage.id} has an owner`);
});

test('the PO recognises reasonable variations of a Hello World request', () => {
  for (const text of [
    'Build a Hello World application',
    'Build a simple Hello World web application.',
    'create a hello-world web page',
    'I need a "Hello, World!" app',
    'HELLOWORLD website please',
  ]) {
    const result = analyse(text);
    assert.equal(result.status, 'ready', text);
    assert.equal(result.spec.recipeId, 'hello-world-web');
    assert.equal(result.spec.acceptanceCriteria.length, 4);
  }
});

test('the PO asks for clarification on unsupported or ambiguous requests', () => {
  const unsupported = analyse('Build a futuristic Breakout game');
  assert.equal(unsupported.status, 'needs_clarification');
  assert.equal(unsupported.reason, 'unsupported');
  assert.deepEqual(unsupported.supported.map((r) => r.title), ['Hello World web application']);

  const ambiguous = analyse('Build a Hello World mobile app with a database');
  assert.equal(ambiguous.status, 'needs_clarification');
  assert.equal(ambiguous.reason, 'ambiguous');
  assert.match(ambiguous.message, /a mobile app and a database/);
});

test('normalizeRequest strips punctuation and case', () => {
  assert.equal(normalizeRequest('  Hello,   WORLD!! '), 'hello world');
});

test('the PO rejects the outcome without QA evidence', () => {
  const { spec } = analyse('Build a Hello World application');
  const review = po.review({ spec, verification: null });
  assert.equal(review.accepted, false);
  assert.match(review.summary, /no QA verification evidence/);
});

test('QA turns a failing acceptance test into a defect with evidence', () => {
  const qa = new QaAgent();
  const { spec } = analyse('Build a Hello World application');
  const tests = spec.acceptanceCriteria.map((c) => ({ name: `${c.id}: ${c.description}`, status: c.id === 'AC2' ? 'fail' : 'pass', expected: 'Hello, World!', actual: 'Hello World', error: 'Expected values to be strictly equal' }));
  const result = qa.evaluate({
    spec,
    results: { missingFiles: [], commands: [{ id: 'tests', kind: 'tests', args: [], exitCode: 1, timedOut: false, stdout: '', stderr: '', tests, summary: { tests: 4, pass: 3, fail: 1 } }] },
  });
  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.defects.map((d) => d.criterionId), ['AC2']);
  assert.match(result.feedbackMessage, /Expected "Hello, World!", got "Hello World"/);
});

test('QA does not pass verification when no tests ran', () => {
  const qa = new QaAgent();
  const { spec } = analyse('Build a Hello World application');
  const result = qa.evaluate({
    spec,
    results: { missingFiles: [], commands: [{ id: 'tests', kind: 'tests', args: [], exitCode: 0, timedOut: false, stdout: '', stderr: '', tests: [], summary: { tests: 0 } }] },
  });
  assert.equal(result.verdict, 'fail');
});

test('QA generates one acceptance test per criterion', () => {
  const { spec } = analyse('Build a Hello World application');
  const source = generateAcceptanceTests(spec.acceptanceCriteria);
  for (const c of spec.acceptanceCriteria) assert.ok(source.includes(`${c.id}: `), c.id);
});

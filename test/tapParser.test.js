import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTap } from '../src/actions/tapParser.js';

// Shape of real `node --test --test-reporter=tap` output (Node 22).
const SAMPLE = `TAP version 13
# Subtest: greets world
ok 1 - greets world
  ---
  duration_ms: 1.698513
  type: 'test'
  ...
# Subtest: greets name
not ok 2 - greets name
  ---
  duration_ms: 2.774409
  type: 'test'
  location: '/tmp/x.test.js:3:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    + actual - expected

    + 'Hello, World!'
    - 'Hello, Ana!'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'Hello, Ana!'
  actual: 'Hello, World!'
  operator: 'strictEqual'
  ...
1..2
# tests 2
# suites 0
# pass 1
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 186.401556
`;

test('parses passing and failing test points', () => {
  const { tests } = parseTap(SAMPLE);
  assert.equal(tests.length, 2);
  assert.deepEqual(
    tests.map((t) => [t.name, t.status, t.durationMs]),
    [
      ['greets world', 'pass', 1.698513],
      ['greets name', 'fail', 2.774409],
    ],
  );
});

test('extracts failure details from the YAML block', () => {
  const failing = parseTap(SAMPLE).tests[1];
  assert.equal(failing.expected, 'Hello, Ana!');
  assert.equal(failing.actual, 'Hello, World!');
  assert.match(failing.error, /^Expected values to be strictly equal:/);
  assert.match(failing.error, /- 'Hello, Ana!'/);
});

test('parses the summary footer', () => {
  const { summary } = parseTap(SAMPLE);
  assert.equal(summary.tests, 2);
  assert.equal(summary.pass, 1);
  assert.equal(summary.fail, 1);
  assert.equal(summary.duration_ms, 186.401556);
});

test('handles skip directives and empty input', () => {
  assert.equal(parseTap('ok 1 - later # SKIP not yet').tests[0].status, 'skip');
  assert.deepEqual(parseTap(''), { tests: [], summary: {} });
});

import { ScriptedAgent } from './agent.js';

export const ACCEPTANCE_TEST_FILE = 'test/acceptance.test.mjs';

const js = (value) => JSON.stringify(value);

// Helpers for static web page checks (included when the criteria need them).
const WEB_HELPERS = `
const read = (path) => readFileSync(join(root, path), 'utf8');
function productFiles(dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'test') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) productFiles(full, out);
    else out.push(full);
  }
  return out;
}
function allCss() {
  let css = '';
  for (const file of productFiles()) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.css')) css += '\\n' + text;
    if (file.endsWith('.html')) {
      for (const m of text.matchAll(/<style[^>]*>([\\s\\S]*?)<\\/style>/gi)) css += '\\n' + m[1];
      for (const m of text.matchAll(/style\\s*=\\s*"([^"]*)"/gi)) css += '\\n;' + m[1] + ';';
      for (const m of text.matchAll(/style\\s*=\\s*'([^']*)'/gi)) css += '\\n;' + m[1] + ';';
    }
  }
  return css.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '');
}
const declarations = () => [...allCss().matchAll(/([a-zA-Z-]+)\\s*:\\s*([^;{}]+)/g)].map((m) => [m[1].toLowerCase(), m[2].trim().replace(/\\s*!important$/i, '')]);
const NAMED_COLORS = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', gray: '#808080', grey: '#808080', brown: '#a52a2a', cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff', lime: '#00ff00', navy: '#000080', teal: '#008080', maroon: '#800000', olive: '#808000', silver: '#c0c0c0', gold: '#ffd700', violet: '#ee82ee', indigo: '#4b0082', darkgreen: '#006400', lightgreen: '#90ee90', darkblue: '#00008b', lightblue: '#add8e6', darkred: '#8b0000', crimson: '#dc143c', coral: '#ff7f50', salmon: '#fa8072', beige: '#f5f5dc', turquoise: '#40e0d0', skyblue: '#87ceeb', limegreen: '#32cd32', forestgreen: '#228b22', tomato: '#ff6347', orchid: '#da70d6' };
function normColor(value) {
  const v = value.trim().toLowerCase();
  if (NAMED_COLORS[v]) return NAMED_COLORS[v];
  let m = v.match(/^#([0-9a-f]{3})$/);
  if (m) return '#' + [...m[1]].map((c) => c + c).join('');
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  m = v.match(/^rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/);
  if (m) return '#' + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  return null;
}
const normValue = (value) => normColor(value) ?? value.toLowerCase().replace(/\\s+/g, ' ').trim();
const SHORTHAND = { 'background-color': 'background', 'border-color': 'border' };
function cssSets(property, value) {
  const want = normValue(value);
  const found = declarations().filter(([p]) => p === property || p === SHORTHAND[property]);
  const ok = found.some(([p, v]) => (p === property ? normValue(v) === want : v.split(/\\s+/).some((token) => normValue(token) === want)));
  return { ok, found: found.map(([p, v]) => p + ': ' + v) };
}
function visibleText(html) {
  return html
    .replace(/<(script|style)[^>]*>[\\s\\S]*?<\\/\\1>/gi, ' ')
    .replace(/<!--[\\s\\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\\s+/g, ' ')
    .trim();
}
`;

const WEB_CHECKS = new Set(['fileExists', 'textVisible', 'htmlTitle', 'cssProperty', 'centeredLayout']);


/** One node:test case per acceptance criterion, from its machine-checkable `check`. */
function testCase(criterion) {
  const name = js(`${criterion.id}: ${criterion.description}`);
  const { check } = criterion;
  switch (check.type) {
    case 'command':
      return [
        `test(${name}, () => {`,
        `  const result = spawnSync(process.execPath, ${js(check.args)}, { cwd: root, encoding: 'utf8' });`,
        `  assert.equal(result.status, ${js(check.expectExitCode)}, 'exit code');`,
        `  assert.equal(result.stdout.trim(), ${js(check.expectStdout)});`,
        '});',
      ].join('\n');
    case 'export':
      return [
        `test(${name}, async () => {`,
        `  const mod = await load(${js(check.module)});`,
        `  assert.equal(typeof mod[${js(check.name)}], 'function', ${js(`${check.module} exports ${check.name}()`)});`,
        `  assert.equal(mod[${js(check.name)}](...${js(check.args)}), ${js(check.expect)});`,
        '});',
      ].join('\n');
    case 'domRender':
      return [
        `test(${name}, async () => {`,
        `  const dependency = await load(${js(check.dependency.module)});`,
        `  const page = await load(${js(check.script)});`,
        `  const element = { id: ${js(check.elementId)}, textContent: '' };`,
        `  const doc = { getElementById: (id) => (id === ${js(check.elementId)} ? element : null) };`,
        `  page[${js(check.fn)}](doc, dependency[${js(check.dependency.name)}]);`,
        `  assert.equal(element.textContent, ${js(check.expect)});`,
        '});',
      ].join('\n');
    case 'fileExists':
      return [`test(${name}, () => {`, `  assert.ok(existsSync(join(root, ${js(check.path)})), ${js(`${check.path} exists`)});`, '});'].join('\n');
    case 'textVisible':
      return [
        `test(${name}, () => {`,
        `  const text = visibleText(read(${js(check.path ?? 'index.html')}));`,
        `  assert.ok(text.includes(${js(check.text)}), ${js(`visible text should contain "${check.text}"`)} + '; visible text is: "' + text.slice(0, 200) + '"');`,
        '});',
      ].join('\n');
    case 'htmlTitle':
      return [
        `test(${name}, () => {`,
        `  const match = read('index.html').match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i);`,
        `  assert.equal(match ? match[1].trim() : '(no <title>)', ${js(check.text)});`,
        '});',
      ].join('\n');
    case 'cssProperty':
      return [
        `test(${name}, () => {`,
        `  const result = cssSets(${js(check.property)}, ${js(check.value)});`,
        `  assert.ok(result.ok, ${js(`expected a CSS rule setting ${check.property}: ${check.value}`)} + '; found: ' + (result.found.join('; ') || 'none'));`,
        '});',
      ].join('\n');
    case 'centeredLayout':
      return [
        `test(${name}, () => {`,
        '  const d = declarations();',
        '  const has = (p, re) => d.some(([pp, v]) => pp === p && re.test(v));',
        "  const centred = has('text-align', /^center$/i) || has('justify-content', /center/i) || has('place-items', /center/i) || has('place-content', /center/i) || has('align-items', /center/i) || has('margin', /auto/i) || /<center>/i.test(read('index.html'));",
        "  assert.ok(centred, 'expected CSS that centres content (text-align:center, flex/grid centring or auto margins)');",
        '});',
      ].join('\n');
    case 'fileContains':
      return [
        `test(${name}, () => {`,
        `  const path = join(root, ${js(check.path)});`,
        `  assert.ok(existsSync(path), ${js(`${check.path} exists`)});`,
        `  const text = readFileSync(path, 'utf8');`,
        ...check.texts.map((t) => `  assert.ok(text.includes(${js(t)}), ${js(`${check.path} contains ${t}`)});`),
        '});',
      ].join('\n');
    default:
      throw new Error(`QA does not know how to check "${check.type}"`);
  }
}

export function generateAcceptanceTests(criteria) {
  return [
    '// Acceptance tests generated by the scripted QA agent from the acceptance criteria.',
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { spawnSync } from 'node:child_process';",
    "import { existsSync, readFileSync, readdirSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { fileURLToPath, pathToFileURL } from 'node:url';",
    '',
    "const root = fileURLToPath(new URL('..', import.meta.url));",
    criteria.some((c) => WEB_CHECKS.has(c.check.type)) ? WEB_HELPERS : '',
    '// Loads a product file whether it is an ES module or a CommonJS script.',
    'const load = async (path) => {',
    '  const mod = await import(pathToFileURL(join(root, path)).href);',
    '  return mod.default ?? mod;',
    '};',
    '',
    criteria.map(testCase).join('\n\n'),
    '',
  ].join('\n');
}

/** Files a criterion's check depends on. */
function checkedFiles(criterion) {
  const { check } = criterion;
  if (check.type === 'command') return [check.args[0]];
  if (check.type === 'export') return [check.module];
  if (check.type === 'domRender') return [check.script, check.dependency.module];
  if (check.type === 'fileExists') return [check.path];
  if (check.type === 'textVisible' || check.type === 'htmlTitle') return [check.path ?? 'index.html'];
  if (check.type === 'fileContains') return [check.path];
  return [];
}

export class QaAgent extends ScriptedAgent {
  constructor() {
    super({
      id: 'qa',
      label: 'QA',
      title: 'Quality Assurance',
      summary: 'Turns the acceptance criteria into tests, runs real verification commands and reports defects.',
      responsibilities: [
        'Reviews the acceptance criteria',
        'Runs automated tests and verification commands',
        'Reports results and defects with evidence',
        'Re-tests corrections',
      ],
    });
  }

  /**
   * Decides what to verify and how.
   *
   * @param {{ spec: import('./productOwner.js').Spec, implementation: { files: string[] } }} input
   * @returns {{ summary: string, testFile: object, requiredFiles: string[],
   *             commands: Array<{ id: string, kind: 'tests' | 'run', label: string, args: string[],
   *                               criterionId?: string, expectStdout?: string, expectExitCode?: number }> }}
   */
  planVerification({ spec, implementation }) {
    const criteria = spec.acceptanceCriteria;
    const requiredFiles = [...new Set([...implementation.files, ...criteria.flatMap(checkedFiles)])];
    const commands = [
      { id: 'tests', kind: 'tests', label: 'Run all automated tests', args: ['--test', '--test-reporter=tap'] },
      ...criteria
        .filter((c) => c.check.type === 'command')
        .map((c) => ({
          id: `run-${c.id}`,
          kind: 'run',
          label: `Run the application for ${c.id}`,
          args: c.check.args,
          criterionId: c.id,
          expectStdout: c.check.expectStdout,
          expectExitCode: c.check.expectExitCode,
        })),
    ];
    return {
      summary:
        `Generated ${criteria.length} acceptance tests (one per criterion) and planned ${commands.length} ` +
        `verification commands.`,
      testFile: {
        path: ACCEPTANCE_TEST_FILE,
        purpose: 'QA acceptance tests from the acceptance criteria',
        content: generateAcceptanceTests(criteria),
      },
      requiredFiles,
      commands,
    };
  }

  /**
   * Judges the recorded results. Only evidence counts.
   *
   * @param {{ spec: import('./productOwner.js').Spec,
   *           results: { missingFiles: string[], commands: Array<{ id: string, kind: string, args: string[],
   *                      exitCode: number | null, timedOut: boolean, stdout: string, stderr: string,
   *                      tests?: object[], summary?: object, criterionId?: string,
   *                      expectStdout?: string, expectExitCode?: number }> } }} input
   */
  evaluate({ spec, results }) {
    const testRun = results.commands.find((c) => c.kind === 'tests');
    const tests = testRun?.tests ?? [];
    const defects = [];

    for (const path of results.missingFiles) {
      defects.push({ title: `Missing file: ${path}`, expected: `${path} exists`, actual: 'File not found', evidence: 'File check' });
    }

    const criteria = spec.acceptanceCriteria.map((criterion) => {
      const test = tests.find((t) => t.name.startsWith(`${criterion.id}:`));
      const run = results.commands.find((c) => c.kind === 'run' && c.criterionId === criterion.id);
      const runOk = !run || (run.exitCode === run.expectExitCode && run.stdout.trim() === run.expectStdout);
      const status = test?.status === 'pass' && runOk ? 'pass' : 'fail';
      const evidence = [
        test ? `Acceptance test ${test.status === 'pass' ? 'passed' : 'failed'}` : 'No acceptance test result',
        run ? `"node ${run.args.join(' ')}" printed "${run.stdout.trim()}" (exit code ${run.exitCode})` : null,
      ]
        .filter(Boolean)
        .join('; ');

      if (status === 'fail') {
        // assert.ok failures only report true/false; their message is the useful part.
        const boolean = test?.expected === 'true' && test?.actual === 'false';
        const message = test?.error?.split('\n')[0];
        defects.push({
          criterionId: criterion.id,
          title: `${criterion.id} not met: ${criterion.description}`,
          expected: boolean ? criterion.description : test?.expected ?? run?.expectStdout ?? 'The criterion to be met',
          actual: boolean ? message : test?.actual ?? (run ? run.stdout.trim() || run.stderr.trim() : null) ?? 'No result',
          evidence: test?.error ? `${evidence}\n\n${test.error}` : evidence,
        });
      }
      return { id: criterion.id, description: criterion.description, status, evidence };
    });

    for (const test of tests.filter((t) => t.status === 'fail' && !/^AC\d+:/.test(t.name))) {
      defects.push({ title: `Test failed: ${test.name}`, expected: test.expected ?? null, actual: test.actual ?? null, evidence: test.error });
    }
    if (testRun && testRun.exitCode !== 0 && !tests.some((t) => t.status === 'fail')) {
      defects.push({
        title: testRun.timedOut ? 'The test run timed out' : `The test run failed (exit code ${testRun.exitCode})`,
        expected: 'Exit code 0',
        actual: `Exit code ${testRun.exitCode}`,
        evidence: testRun.stderr.trim().slice(0, 2000) || 'No error output',
      });
    }

    const summary = testRun?.summary ?? {};
    const verdict = defects.length === 0 && testRun?.exitCode === 0 && summary.tests > 0 ? 'pass' : 'fail';
    const met = criteria.filter((c) => c.status === 'pass').length;
    const testText = `${summary.pass ?? 0} of ${summary.tests ?? 0} automated tests passed`;

    if (verdict === 'pass') {
      return {
        verdict,
        criteria,
        defects,
        testSummary: summary,
        summary: `Verification passed: ${met} of ${criteria.length} acceptance criteria met; ${testText}.`,
        handoffMessage:
          `Verification passed: all ${criteria.length} acceptance criteria are met and ${testText}. ` +
          `The implementation is ready for your review.`,
      };
    }
    const first = defects[0] ?? { title: 'No automated tests were found or run', expected: null };
    return {
      verdict,
      criteria,
      defects,
      testSummary: summary,
      summary:
        `Verification failed: ${met} of ${criteria.length} acceptance criteria met; ${testText}; ` +
        `${defects.length} defect(s) found.`,
      feedbackMessage:
        `Verification failed with ${defects.length} defect(s). ${first.title}. ` +
        (first.expected != null ? `Expected "${first.expected}", got "${first.actual}". ` : '') +
        'Please correct the implementation and hand it back for re-testing.',
    };
  }
}

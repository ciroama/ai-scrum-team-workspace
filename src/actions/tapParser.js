// Parses the TAP output of `node --test --test-reporter=tap`.
//
// Only the parts needed for reporting are understood: test points
// (`ok` / `not ok`), their YAML diagnostic blocks (duration and failure
// details) and the summary footer (`# tests`, `# pass`, ...).

const TEST_POINT = /^(\s*)(not ok|ok) (\d+) - (.*?)(?: # (SKIP|TODO)\b.*)?$/i;
const SUMMARY = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)$/;
const YAML_SCALAR = /^\s*(\w+): (.*)$/;

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

/** Parses a TAP YAML diagnostic block (the lines between `---` and `...`). */
function parseYamlBlock(lines) {
  const result = {};
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(YAML_SCALAR);
    if (!match) continue;
    const [, key, raw] = match;
    if (raw === '|-' || raw === '|' || raw === '>-') {
      // Block scalar: every following line indented deeper than the key.
      const keyIndent = lines[i].search(/\S/);
      const body = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || lines[i + 1].search(/\S/) > keyIndent)) {
        body.push(lines[++i]);
      }
      const bodyIndent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
      result[key] = body.map((l) => l.slice(bodyIndent)).join('\n').trimEnd();
    } else {
      result[key] = unquote(raw);
    }
  }
  return result;
}

/**
 * @param {string} tap full TAP output
 * @returns {{ tests: Array<{ name: string, number: number, depth: number, status: 'pass' | 'fail' | 'skip' | 'todo',
 *                            durationMs: number | null, error?: string, expected?: string, actual?: string }>,
 *             summary: Record<string, number> }}
 */
export function parseTap(tap) {
  const lines = tap.split(/\r?\n/);
  const tests = [];
  const summary = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const summaryMatch = line.match(SUMMARY);
    if (summaryMatch) {
      summary[summaryMatch[1]] = Number(summaryMatch[2]);
      continue;
    }

    const point = line.match(TEST_POINT);
    if (!point) continue;

    const [, indent, okText, number, name, directive] = point;
    let status = okText.toLowerCase() === 'ok' ? 'pass' : 'fail';
    if (directive) status = directive.toLowerCase() === 'skip' ? 'skip' : 'todo';

    const test = { name, number: Number(number), depth: indent.length / 4, status, durationMs: null };

    // Optional YAML block directly after the test point.
    if (lines[i + 1]?.trim() === '---') {
      const block = [];
      i += 2;
      while (i < lines.length && lines[i].trim() !== '...') block.push(lines[i++]);
      const yaml = parseYamlBlock(block);
      if (yaml.duration_ms) test.durationMs = Number(yaml.duration_ms);
      if (yaml.type === 'suite') test.suite = true;
      if (status === 'fail') {
        test.error = yaml.error ?? yaml.failureType ?? 'Test failed';
        if ('expected' in yaml) test.expected = yaml.expected;
        if ('actual' in yaml) test.actual = yaml.actual;
      }
    }
    tests.push(test);
  }

  return { tests, summary };
}

// Recipe: Hello World application.
//
// A recipe is the scripted knowledge the agents use for one supported
// request type: how the PO recognises and refines it, which files the
// Developer produces, and which checks the acceptance criteria define for QA.

const PACKAGE_JSON = `${JSON.stringify(
  {
    name: 'hello-world-app',
    version: '1.0.0',
    private: true,
    type: 'module',
    description: 'Hello World command-line application built by the AI Scrum Team Workspace.',
    scripts: { start: 'node app.js', test: 'node --test' },
  },
  null,
  2,
)}\n`;

const GREET_JS = `/**
 * Returns the greeting shown by the application.
 * @param {string} [name]
 */
export function greet(name = 'World') {
  return \`Hello, \${name}!\`;
}
`;

const APP_JS = `import { greet } from './src/greet.js';

console.log(greet());
`;

const UNIT_TEST_JS = `import test from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../src/greet.js';

test('greet() greets the world by default', () => {
  assert.equal(greet(), 'Hello, World!');
});

test('greet(name) greets the given name', () => {
  assert.equal(greet('Ana'), 'Hello, Ana!');
});
`;

const README_MD = `# Hello World application

A small command-line application that prints a greeting.

## Run

\`\`\`bash
node app.js
\`\`\`

Expected output:

\`\`\`
Hello, World!
\`\`\`

## Test

\`\`\`bash
node --test
\`\`\`

Requires Node.js 22. Built by the scripted agents of the AI Scrum Team Workspace.
`;

export default {
  id: 'hello-world-app',
  title: 'Hello World application',
  summary: 'A small Node.js command-line application that prints "Hello, World!", with automated tests and a README.',
  examples: ['Build a Hello World application.', 'Create a hello world app', 'I need a "Hello, World!" program'],

  /** @param {string} normalized lower-cased request with punctuation removed */
  matches(normalized) {
    return /\bhello ?world\b/.test(normalized);
  },

  /**
   * Things the request asks for that this recipe does not deliver. Any match
   * makes the PO ask for clarification instead of guessing.
   */
  conflicts: [
    { pattern: /\b(web ?sites?|web ?pages?|html|browser|landing page)\b/, label: 'a website or web page' },
    { pattern: /\b(games?|breakout|arcade)\b/, label: 'a game' },
    { pattern: /\b(mobile|ios|android|iphone|ipad)\b/, label: 'a mobile app' },
    { pattern: /\b(api|server|backend|rest|endpoint)\b/, label: 'a server or API' },
    { pattern: /\b(database|sql|sqlite|postgres|mysql)\b/, label: 'a database' },
    { pattern: /\b(python|java|ruby|php|rust|swift|kotlin|typescript|c sharp)\b/, label: 'a specific programming language' },
  ],

  requirements: [
    'Provide a command-line application that prints the greeting "Hello, World!".',
    'Keep the greeting logic in a reusable function, separate from the program entry point.',
    'Include a README that explains how to run the application.',
    'Include automated tests for the greeting logic.',
  ],

  /**
   * Each criterion carries a machine-checkable `check` that QA turns into an
   * acceptance test. Check types: command, export, fileContains.
   */
  acceptanceCriteria: [
    {
      id: 'AC1',
      description: 'Running `node app.js` prints exactly "Hello, World!" and exits successfully.',
      check: { type: 'command', args: ['app.js'], expectStdout: 'Hello, World!', expectExitCode: 0 },
    },
    {
      id: 'AC2',
      description: 'The greeting logic is reusable: greet() from src/greet.js returns "Hello, World!".',
      check: { type: 'export', module: 'src/greet.js', name: 'greet', args: [], expect: 'Hello, World!' },
    },
    {
      id: 'AC3',
      description: 'The product includes a README.md that explains how to run it with `node app.js`.',
      check: { type: 'fileContains', path: 'README.md', text: 'node app.js' },
    },
  ],

  /** Files the Developer writes. */
  implementation() {
    return [
      { path: 'package.json', purpose: 'Project manifest (ES modules, start and test scripts)', content: PACKAGE_JSON },
      { path: 'src/greet.js', purpose: 'Reusable greeting function', content: GREET_JS },
      { path: 'app.js', purpose: 'Application entry point', content: APP_JS },
      { path: 'test/greet.test.js', purpose: 'Developer unit tests', content: UNIT_TEST_JS },
      { path: 'README.md', purpose: 'How to run and test the application', content: README_MD },
    ];
  },
};

// Recipe: Hello World web application.
//
// A recipe is the scripted knowledge the agents use for one supported
// request type: how the PO recognises and refines it, which files the
// Developer produces, and which checks the acceptance criteria define for QA.
//
// The product is a static web page that also works when index.html is
// opened directly from disk: it uses classic scripts (no ES modules, which
// browsers block on file://). The scripts also export their functions to
// Node so QA can verify them without a browser.

const PACKAGE_JSON = `${JSON.stringify(
  {
    name: 'hello-world-web',
    version: '1.0.0',
    private: true,
    type: 'commonjs',
    description: 'Hello World web application built by the AI Scrum Team Workspace.',
    scripts: { test: 'node --test' },
  },
  null,
  2,
)}\n`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hello World</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main class="card">
      <h1 id="greeting">Loading…</h1>
      <p>A static web page built by the AI Scrum Team Workspace.</p>
    </main>
    <script src="src/greet.js"></script>
    <script src="app.js"></script>
  </body>
</html>
`;

const STYLES_CSS = `body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: #0b1020;
  color: #e6ebf5;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
}

.card {
  padding: 40px 56px;
  border-radius: 16px;
  background: #141c33;
  border: 1px solid rgba(148, 163, 184, 0.2);
  text-align: center;
}

h1 {
  margin: 0 0 8px;
  color: #22d3ee;
}
`;

const GREET_JS = `// Greeting logic. Works as a browser script (window.HelloWorld) and as a
// Node module (module.exports) so it can be tested without a browser.
(function (root) {
  function greet(name) {
    return 'Hello, ' + (name || 'World') + '!';
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { greet: greet };
  } else {
    root.HelloWorld = { greet: greet };
  }
})(this);
`;

const APP_JS = `// Page script: writes the greeting into the page.
(function (root) {
  function renderGreeting(doc, greet) {
    var element = doc.getElementById('greeting');
    element.textContent = greet();
    return element.textContent;
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { renderGreeting: renderGreeting };
  } else {
    renderGreeting(root.document, root.HelloWorld.greet);
  }
})(this);
`;

const UNIT_TEST_JS = `const test = require('node:test');
const assert = require('node:assert/strict');
const { greet } = require('../src/greet.js');
const { renderGreeting } = require('../app.js');

test('greet() greets the world by default', () => {
  assert.equal(greet(), 'Hello, World!');
});

test('greet(name) greets the given name', () => {
  assert.equal(greet('Ana'), 'Hello, Ana!');
});

test('renderGreeting() writes the greeting into the #greeting element', () => {
  const element = { textContent: '' };
  const doc = { getElementById: (id) => (id === 'greeting' ? element : null) };
  renderGreeting(doc, greet);
  assert.equal(element.textContent, 'Hello, World!');
});
`;

const README_MD = `# Hello World web application

A small static web page that shows a greeting.

## Open it

Double-click \`index.html\`, or open it in Safari or Chrome. The page shows:

\`\`\`
Hello, World!
\`\`\`

No server and no internet connection are needed.

## Test

\`\`\`bash
node --test
\`\`\`

Requires Node.js 22. Built by the scripted agents of the AI Scrum Team Workspace.
`;

export default {
  id: 'hello-world-web',
  title: 'Hello World web application',
  summary: 'A small static web page (index.html, a page script and a greeting module) that shows "Hello, World!", verified with Node tests.',
  examples: ['Build a Hello World application.', 'Build a simple Hello World web application.', 'Create a hello world web page'],

  /** @param {string} normalized lower-cased request with punctuation removed */
  matches(normalized) {
    return /\bhello ?world\b/.test(normalized);
  },

  /**
   * Things the request asks for that this recipe does not deliver. Any match
   * makes the PO ask for clarification instead of guessing.
   */
  conflicts: [
    { pattern: /\b(command line|cli|terminal app|console app)\b/, label: 'a command-line application' },
    { pattern: /\b(games?|breakout|arcade)\b/, label: 'a game' },
    { pattern: /\b(mobile|ios|android|iphone|ipad)\b/, label: 'a mobile app' },
    { pattern: /\b(api|server|backend|rest|endpoint)\b/, label: 'a server or API' },
    { pattern: /\b(database|sql|sqlite|postgres|mysql)\b/, label: 'a database' },
    { pattern: /\b(react|vue|angular|svelte|framework)\b/, label: 'a specific web framework' },
    { pattern: /\b(python|java|ruby|php|rust|swift|kotlin|typescript|c sharp)\b/, label: 'a specific programming language' },
  ],

  requirements: [
    'Provide a static web page (index.html) that shows the greeting "Hello, World!".',
    'Keep the greeting logic in a reusable module, separate from the page script.',
    'The page must work when index.html is opened directly, without a server or internet access.',
    'Include a README that explains how to open the page.',
    'Include automated tests that verify the greeting without a browser.',
  ],

  /**
   * Each criterion carries a machine-checkable `check` that QA turns into an
   * acceptance test. Check types: fileContains, export, domRender, command.
   */
  acceptanceCriteria: [
    {
      id: 'AC1',
      description: 'index.html is a web page titled "Hello World" with a #greeting element that loads src/greet.js and app.js.',
      check: {
        type: 'fileContains',
        path: 'index.html',
        texts: ['<title>Hello World</title>', 'id="greeting"', '<script src="src/greet.js"></script>', '<script src="app.js"></script>'],
      },
    },
    {
      id: 'AC2',
      description: 'When the page script runs, the #greeting element shows exactly "Hello, World!".',
      check: { type: 'domRender', script: 'app.js', fn: 'renderGreeting', elementId: 'greeting', dependency: { module: 'src/greet.js', name: 'greet' }, expect: 'Hello, World!' },
    },
    {
      id: 'AC3',
      description: 'The greeting logic is reusable: greet() from src/greet.js returns "Hello, World!".',
      check: { type: 'export', module: 'src/greet.js', name: 'greet', args: [], expect: 'Hello, World!' },
    },
    {
      id: 'AC4',
      description: 'The product includes a README.md that explains how to open index.html.',
      check: { type: 'fileContains', path: 'README.md', texts: ['index.html'] },
    },
  ],

  /** Files the Developer writes. */
  implementation() {
    return [
      { path: 'package.json', purpose: 'Project manifest (test script)', content: PACKAGE_JSON },
      { path: 'index.html', purpose: 'The web page', content: INDEX_HTML },
      { path: 'styles.css', purpose: 'Page styling', content: STYLES_CSS },
      { path: 'src/greet.js', purpose: 'Reusable greeting module', content: GREET_JS },
      { path: 'app.js', purpose: 'Page script that shows the greeting', content: APP_JS },
      { path: 'test/greet.test.js', purpose: 'Developer unit tests', content: UNIT_TEST_JS },
      { path: 'README.md', purpose: 'How to open and test the page', content: README_MD },
    ];
  },
};

import { ScriptedAgent } from './agent.js';

const CORRECT_IMPLEMENTATION = `/**
 * Returns a greeting. Blank or missing names fall back to "World".
 * @param {string} [name]
 */
export function greet(name) {
  const who = typeof name === 'string' && name.trim() !== '' ? name.trim() : 'World';
  return \`Hello, \${who}!\`;
}
`;

// Used only in the "faulty" run mode, to show that test results are real:
// this implementation ignores its argument, so AC2 must fail.
const FAULTY_IMPLEMENTATION = `// DEFECT INJECTED ON PURPOSE (run mode "faulty"): the name argument is ignored.
export function greet(name) {
  return 'Hello, World!';
}
`;

export class DeveloperAgent extends ScriptedAgent {
  constructor() {
    super({
      id: 'dev',
      name: 'Dev',
      role: 'Developer',
      summary: 'Implements stories as working code in the run workspace.',
      responsibilities: ['Implements the story', 'Keeps code small and readable', 'Hands work to QA'],
    });
  }

  async perform({ mode }) {
    const faulty = mode === 'faulty';
    return {
      messages: faulty
        ? [
            'Used the "hello-world" code template with a deliberately injected defect (faulty mode).',
            'The defect: greet() ignores its name argument.',
          ]
        : ['Used the "hello-world" code template to implement greet(name) in hello.js.'],
      actions: [
        {
          type: 'writeFile',
          path: 'package.json',
          purpose: 'Marks the workspace as an ES module package',
          content: `${JSON.stringify({ name: 'hello-world', private: true, type: 'module' }, null, 2)}\n`,
        },
        {
          type: 'writeFile',
          path: 'hello.js',
          purpose: faulty ? 'Implementation (with injected defect)' : 'Implementation',
          content: faulty ? FAULTY_IMPLEMENTATION : CORRECT_IMPLEMENTATION,
        },
      ],
    };
  }
}

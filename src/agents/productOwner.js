import { ScriptedAgent } from './agent.js';

/**
 * Refinement templates, keyed by story workflow. The scripted PO can only
 * refine stories it has a template for.
 */
const TEMPLATES = {
  'hello-world': [
    {
      id: 'AC1',
      description: 'greet() with no name returns "Hello, World!"',
      call: { args: [] },
      expected: 'Hello, World!',
    },
    {
      id: 'AC2',
      description: 'greet("Ana") greets the given name: "Hello, Ana!"',
      call: { args: ['Ana'] },
      expected: 'Hello, Ana!',
    },
    {
      id: 'AC3',
      description: 'greet("   ") with a blank name falls back to "Hello, World!"',
      call: { args: ['   '] },
      expected: 'Hello, World!',
    },
  ],
};

function acceptanceMarkdown(story, criteria) {
  return [
    `# Acceptance criteria: ${story.title}`,
    '',
    story.description,
    '',
    ...criteria.map((c) => `- **${c.id}**: ${c.description}`),
    '',
    `_Written by the scripted PO agent from the "${story.workflow}" refinement template._`,
    '',
  ].join('\n');
}

export class ProductOwnerAgent extends ScriptedAgent {
  constructor() {
    super({
      id: 'po',
      name: 'PO',
      role: 'Product Owner',
      summary: 'Refines stories into acceptance criteria and accepts or rejects the result.',
      responsibilities: ['Owns the backlog', 'Writes acceptance criteria', 'Accepts the increment against the definition of done'],
    });
  }

  async perform(task, context) {
    switch (task.step) {
      case 'refine':
        return this.#refine(task.story);
      case 'accept':
        return this.#accept(context);
      default:
        throw new Error(`The PO has no behaviour for step "${task.step}"`);
    }
  }

  #refine(story) {
    const template = TEMPLATES[story.workflow];
    if (!template) throw new Error(`The scripted PO has no refinement template for workflow "${story.workflow}"`);

    const criteria = template.map((c) => ({ ...c }));
    return {
      messages: [
        `Applied the "${story.workflow}" refinement template to "${story.title}".`,
        `Defined ${criteria.length} acceptance criteria: ${criteria.map((c) => c.id).join(', ')}.`,
      ],
      actions: [
        {
          type: 'writeFile',
          path: 'ACCEPTANCE.md',
          purpose: 'Acceptance criteria for the story',
          content: acceptanceMarkdown(story, criteria),
        },
      ],
      output: { acceptance: criteria },
    };
  }

  #accept({ verdict }) {
    const accepted = verdict === 'pass';
    return {
      messages: accepted
        ? ['Definition of done met: QA reports every acceptance test passing. Story accepted and moved to Done.']
        : ['Definition of done NOT met: QA reports failing acceptance tests. Story rejected and marked Failed.'],
      output: { storyStatus: accepted ? 'done' : 'failed', runStatus: accepted ? 'passed' : 'failed' },
    };
  }
}

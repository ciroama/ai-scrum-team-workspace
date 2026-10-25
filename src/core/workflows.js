/**
 * Workflow definitions: the ordered steps a story goes through and which
 * agent owns each step. The orchestrator (platform code, not an agent)
 * runs the steps in order.
 */
export const WORKFLOWS = {
  'hello-world': {
    id: 'hello-world',
    title: 'Hello World delivery',
    steps: [
      { id: 'refine', title: 'Refine story into acceptance criteria', agent: 'po' },
      { id: 'implement', title: 'Implement the story', agent: 'dev' },
      { id: 'verify', title: 'Write and run acceptance tests', agent: 'qa' },
      { id: 'accept', title: 'Accept or reject against definition of done', agent: 'po' },
    ],
  },
};

/** Stories present in every new workspace. */
export const SEED_STORIES = [
  {
    id: 'story-hello-world',
    title: 'Hello World greeting module',
    description:
      'As a user I want a greet(name) function so that I am greeted by name, or with "Hello, World!" when no name is given.',
    workflow: 'hello-world',
  },
];

export const RUN_MODES = {
  standard: 'Standard run',
  faulty: 'Run with an injected defect (shows a real failing test)',
};

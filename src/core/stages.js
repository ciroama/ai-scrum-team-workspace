/**
 * Workflow stages and the role responsible for each. The orchestrator moves
 * between them based on agent outputs; correction loops back to
 * verification.
 */
export const STAGES = {
  analysis: { id: 'analysis', title: 'Requirement analysis', agent: 'po', taskTitle: 'Analyse the requirement' },
  implementation: { id: 'implementation', title: 'Implementation', agent: 'dev', taskTitle: 'Implement the requirements' },
  verification: { id: 'verification', title: 'Verification', agent: 'qa', taskTitle: 'Verify the implementation' },
  correction: { id: 'correction', title: 'Correction', agent: 'dev', taskTitle: 'Fix the reported defects' },
  review: { id: 'review', title: 'Final review', agent: 'po', taskTitle: 'Review the verified outcome' },
  // The Developer or QA asked the PO before doing their work.
  consultation: { id: 'consultation', title: "Team's questions", agent: 'po', taskTitle: "Answer the team's questions" },
};

/** Display order; correction only happens when QA reports defects. */
export const STAGE_ORDER = ['analysis', 'implementation', 'verification', 'correction', 'review'];

/** Implementation attempts (first build plus corrections) before giving up. */
export const MAX_IMPLEMENTATION_ATTEMPTS = 3;

/** Agents that still have work ahead of them in a given stage. */
export const UPCOMING_AGENTS = {
  analysis: ['dev', 'qa'],
  implementation: ['qa', 'po'],
  correction: ['qa', 'po'],
  verification: ['po', 'dev'],
  review: [],
  consultation: ['dev', 'qa'],
};

export const WORKFLOW_STATUS = {
  running: 'Running',
  blocked: 'Blocked',
  completed: 'Completed',
  failed: 'Failed',
  needs_clarification: 'Waiting for you',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
};

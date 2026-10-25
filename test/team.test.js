import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeam } from '../src/agents/team.js';
import { AgentKind } from '../src/agents/agent.js';
import { WORKFLOWS } from '../src/core/workflows.js';

test('the team is PO, Dev and QA', () => {
  const team = createTeam();
  assert.deepEqual(
    [...team.values()].map((a) => [a.id, a.profile.name, a.profile.role]),
    [
      ['po', 'PO', 'Product Owner'],
      ['dev', 'Dev', 'Developer'],
      ['qa', 'QA', 'Quality Assurance'],
    ],
  );
});

test('every Milestone 1 agent is scripted, not AI-powered', () => {
  for (const agent of createTeam().values()) {
    assert.equal(agent.kind, AgentKind.SCRIPTED, `${agent.id} must be scripted`);
    assert.equal(agent.profile.kind, AgentKind.SCRIPTED);
  }
});

test('every workflow step is owned by a team member', () => {
  const team = createTeam();
  for (const workflow of Object.values(WORKFLOWS)) {
    for (const step of workflow.steps) assert.ok(team.has(step.agent), `${workflow.id}/${step.id} -> ${step.agent}`);
  }
});

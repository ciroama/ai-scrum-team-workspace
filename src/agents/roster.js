import { createTeam } from './team.js';
import { AiDeveloperAgent, AiProductOwnerAgent } from './ai/aiAgents.js';

/**
 * The team as seen by the orchestrator. For each role it returns the agent
 * that matches the configured mode: the scripted agent, or the AI-powered
 * one where it exists (PO and Developer). QA is always scripted so that
 * verification stays independent of the model that wrote the code.
 *
 * Offers the Map methods the orchestrator and read models use.
 */
export class TeamRoster {
  /**
   * @param {object} deps
   * @param {(agentId: string) => 'scripted' | 'ai'} deps.getMode
   * @param {() => import('../ai/claudeCode.js').ClaudeCodeClient} deps.getClient
   * @param {Map<string, object>} [deps.scripted]
   */
  constructor({ getMode, getClient, scripted = createTeam() }) {
    this.getMode = getMode;
    this.scripted = scripted;
    this.ai = new Map([
      ['po', new AiProductOwnerAgent({ getClient })],
      ['dev', new AiDeveloperAgent({ getClient })],
    ]);
  }

  supportsAi(agentId) {
    return this.ai.has(agentId);
  }

  get(agentId) {
    if (this.ai.has(agentId) && this.getMode(agentId) === 'ai') return this.ai.get(agentId);
    return this.scripted.get(agentId);
  }

  has(agentId) {
    return this.scripted.has(agentId);
  }

  keys() {
    return this.scripted.keys();
  }

  values() {
    return [...this.scripted.keys()].map((id) => this.get(id)).values();
  }
}

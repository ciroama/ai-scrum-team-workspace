import { createTeam } from './team.js';
import { AiDeveloperAgent, AiProductOwnerAgent, AiQaAgent } from './ai/aiAgents.js';

/**
 * The team as seen by the orchestrator. For each role it returns the agent
 * that matches the configured mode: the scripted agent or the AI-powered one.
 * An AI-powered QA still runs the deterministic checks, so verification never
 * depends only on a model.
 *
 * Offers the Map methods the orchestrator and read models use.
 */
export class TeamRoster {
  /**
   * @param {object} deps
   * @param {(agentId: string) => 'scripted' | 'ai'} deps.getMode
   * @param {(agentId: string) => import('../ai/claudeCode.js').ClaudeCodeClient} deps.getClient  each agent gets a client for its own model
   * @param {Map<string, object>} [deps.scripted]
   */
  constructor({ getMode, getClient, scripted = createTeam() }) {
    this.getMode = getMode;
    this.scripted = scripted;
    this.ai = new Map([
      ['po', new AiProductOwnerAgent({ getClient: () => getClient('po') })],
      ['dev', new AiDeveloperAgent({ getClient: () => getClient('dev') })],
      ['qa', new AiQaAgent({ getClient: () => getClient('qa') })],
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

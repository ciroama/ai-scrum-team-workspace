/**
 * Agent kinds.
 *
 *  - SCRIPTED: behaviour is fixed rules and templates written in this code
 *    base. No AI model is involved. Every agent in Milestone 1 is scripted.
 *  - AI: reserved for future model-backed agents (local model, Claude Code
 *    CLI, API key, ...). Not implemented in Milestone 1.
 */
export const AgentKind = Object.freeze({ SCRIPTED: 'scripted', AI: 'ai' });

/**
 * @typedef {object} AgentProfile
 * @property {string} id
 * @property {string} name
 * @property {string} role
 * @property {string} summary
 * @property {string[]} responsibilities
 */

/**
 * @typedef {object} Action
 * A request for the platform to do real work on the agent's behalf.
 * @property {'writeFile' | 'runTests'} type
 */

/**
 * @typedef {object} AgentResult
 * @property {string[]} messages  what the agent reports (shown verbatim)
 * @property {Action[]} [actions] work for the platform to execute
 * @property {object} [output]    data merged into the run context
 */

/**
 * Base class for all agents. An agent decides; the orchestrator executes
 * the actions it asks for and records every step as an event.
 */
export class Agent {
  /**
   * @param {AgentProfile} profile
   * @param {string} kind one of AgentKind
   */
  constructor(profile, kind) {
    if (!Object.values(AgentKind).includes(kind)) throw new Error(`Unknown agent kind: ${kind}`);
    this.profile = Object.freeze({ ...profile, kind });
  }

  get id() {
    return this.profile.id;
  }

  get kind() {
    return this.profile.kind;
  }

  /**
   * Decide what to do for a workflow step.
   * @returns {Promise<AgentResult>}
   */
  async perform(_task, _context) {
    throw new Error(`${this.id} does not implement perform()`);
  }

  /**
   * Optional: inspect the results of the actions requested in perform().
   * @returns {Promise<AgentResult>}
   */
  async review(_task, _context, _actionResults) {
    return { messages: [] };
  }
}

/** An agent whose behaviour is entirely rule/template based. */
export class ScriptedAgent extends Agent {
  /** @param {AgentProfile} profile */
  constructor(profile) {
    super(profile, AgentKind.SCRIPTED);
  }
}

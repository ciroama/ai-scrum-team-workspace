/**
 * Agent kinds.
 *
 *  - SCRIPTED: behaviour is fixed rules and templates written in this code
 *    base. No AI model is involved and no autonomous reasoning happens.
 *    Every agent in this milestone is scripted.
 *  - AI: reserved for future model-backed agents (local model, Claude Code
 *    CLI, API key, ...). Not implemented.
 */
export const AgentKind = Object.freeze({ SCRIPTED: 'scripted', AI: 'ai' });

/**
 * @typedef {object} AgentProfile
 * @property {string} id
 * @property {string} label           short name shown in the UI ("PO")
 * @property {string} title           full role name ("Product Owner")
 * @property {string} summary
 * @property {string[]} responsibilities
 */

/**
 * Base class for all agents. Agents only decide and describe: they return
 * structured outputs (requirements, files to write, commands to run,
 * verdicts). The orchestrator executes the work and records every step.
 *
 * Each role has its own contract (see productOwner.js, developer.js,
 * qa.js). A future AI-powered agent implements the same methods.
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

  get label() {
    return this.profile.label;
  }
}

/** An agent whose behaviour is entirely rule/template based. */
export class ScriptedAgent extends Agent {
  /** @param {AgentProfile} profile */
  constructor(profile) {
    super(profile, AgentKind.SCRIPTED);
  }
}

/**
 * An agent cannot do its work right now for a reason the user can fix
 * (configuration, AI service unavailable). Workflows block with this
 * message instead of failing, and can be resumed.
 */
export class AgentBlockedError extends Error {
  constructor(message, cause = 'agent_unavailable') {
    super(message);
    this.blocking = true;
    this.cause = cause;
  }
}

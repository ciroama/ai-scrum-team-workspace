// Local AI configuration (Claude Code). Only the model is stored, in the
// workspace database under data/; the login belongs to Claude Code itself.

import { CLAUDE_CODE, ClaudeCodeClient } from './claudeCode.js';

const KEYS = { model: 'ai.claudeCode.model', lastCheck: 'ai.claudeCode.lastCheck' };
// Settings of the retired GitHub Models integration, removed on start so an
// old token does not stay on disk.
const LEGACY_KEYS = ['ai.githubModels.token', 'ai.githubModels.model', 'ai.githubModels.lastCheck'];
const MODEL_PATTERN = /^[A-Za-z0-9._[\]-]{1,80}$/;

export class AiSettings {
  /**
   * @param {object} deps
   * @param {import('../storage/repository.js').Repository} deps.repository
   * @param {string} [deps.binary]  the `claude` command (overridable for tests)
   */
  constructor({ repository, binary = 'claude' }) {
    this.repository = repository;
    this.binary = binary;
    for (const key of LEGACY_KEYS) if (repository.getSetting(key) != null) repository.setSetting(key, null);
  }

  get model() {
    return this.repository.getSetting(KEYS.model) || CLAUDE_CODE.defaultModel;
  }

  status() {
    const lastCheck = this.repository.getSetting(KEYS.lastCheck);
    return {
      provider: CLAUDE_CODE.id,
      providerName: CLAUDE_CODE.name,
      model: this.model,
      defaultModel: CLAUDE_CODE.defaultModel,
      suggestedModels: CLAUDE_CODE.suggestedModels,
      lastCheck: lastCheck ? JSON.parse(lastCheck) : null,
    };
  }

  /**
   * @param {{ model?: string }} changes  model "" restores the default
   * @returns {{ ok: true } | { ok: false, error: string }}
   */
  update({ model }) {
    if (model !== undefined) {
      if (typeof model !== 'string' || (model.trim() && !MODEL_PATTERN.test(model.trim()))) {
        return { ok: false, error: 'The model must be a Claude Code model name, e.g. sonnet, opus or haiku.' };
      }
      this.repository.setSetting(KEYS.model, model.trim() || null);
      this.repository.setSetting(KEYS.lastCheck, null);
    }
    return { ok: true };
  }

  client() {
    return new ClaudeCodeClient({ model: this.model, binary: this.binary });
  }

  /** Sends one tiny real request and records the outcome. */
  async test() {
    const at = new Date().toISOString();
    let result;
    try {
      const answer = await this.client().chatJson({ system: 'Answer with the JSON object {"ok": true} and nothing else.', user: 'Connection test' });
      result = { ok: true, at, model: answer.model, durationMs: answer.durationMs, message: `Claude Code answered (${answer.model}).` };
    } catch (error) {
      result = { ok: false, at, message: error.message };
    }
    this.repository.setSetting(KEYS.lastCheck, JSON.stringify(result));
    return result;
  }
}

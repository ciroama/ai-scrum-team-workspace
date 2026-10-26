// Local AI configuration (GitHub Models). Stored in the workspace database
// under data/, which is not in Git. The token is never sent back to the
// browser: the API only reports whether one is configured.

import { GITHUB_MODELS, GitHubModelsClient } from './githubModels.js';

const KEYS = { token: 'ai.githubModels.token', model: 'ai.githubModels.model', lastCheck: 'ai.githubModels.lastCheck' };
const MODEL_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_]{20,255}$/;

export class AiSettings {
  /**
   * @param {object} deps
   * @param {import('../storage/repository.js').Repository} deps.repository
   * @param {string} [deps.endpoint]  overridable for tests
   * @param {typeof fetch} [deps.fetchImpl]
   */
  constructor({ repository, endpoint = GITHUB_MODELS.endpoint, fetchImpl }) {
    this.repository = repository;
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
  }

  get model() {
    return this.repository.getSetting(KEYS.model) || GITHUB_MODELS.defaultModel;
  }

  status() {
    const token = this.repository.getSetting(KEYS.token);
    const lastCheck = this.repository.getSetting(KEYS.lastCheck);
    return {
      provider: GITHUB_MODELS.id,
      providerName: GITHUB_MODELS.name,
      endpoint: this.endpoint,
      model: this.model,
      defaultModel: GITHUB_MODELS.defaultModel,
      tokenConfigured: Boolean(token),
      tokenHint: token ? `…${token.slice(-4)}` : null,
      lastCheck: lastCheck ? JSON.parse(lastCheck) : null,
    };
  }

  /**
   * @param {{ token?: string, model?: string }} changes  token "" removes it
   * @returns {{ ok: true } | { ok: false, error: string }}
   */
  update({ token, model }) {
    if (token !== undefined) {
      if (typeof token !== 'string') return { ok: false, error: 'The token must be text.' };
      const trimmed = token.trim();
      if (trimmed && !TOKEN_PATTERN.test(trimmed)) {
        return { ok: false, error: 'This does not look like a GitHub token (it usually starts with "github_pat_").' };
      }
      this.repository.setSetting(KEYS.token, trimmed || null);
      this.repository.setSetting(KEYS.lastCheck, null);
    }
    if (model !== undefined) {
      if (typeof model !== 'string' || (model.trim() && !MODEL_PATTERN.test(model.trim()))) {
        return { ok: false, error: 'The model must look like "publisher/model", e.g. openai/gpt-4.1-mini.' };
      }
      this.repository.setSetting(KEYS.model, model.trim() || null);
      this.repository.setSetting(KEYS.lastCheck, null);
    }
    return { ok: true };
  }

  client() {
    return new GitHubModelsClient({
      token: this.repository.getSetting(KEYS.token),
      model: this.model,
      endpoint: this.endpoint,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
  }

  /** Sends one tiny real request and records the outcome. */
  async test() {
    const at = new Date().toISOString();
    let result;
    try {
      const answer = await this.client().chatJson({ system: 'Answer with the JSON object {"ok": true} and nothing else.', user: 'Connection test', maxTokens: 20 });
      result = { ok: true, at, model: answer.model, durationMs: answer.durationMs, message: `Connected to ${GITHUB_MODELS.name} (${answer.model}).` };
    } catch (error) {
      result = { ok: false, at, message: error.message };
    }
    this.repository.setSetting(KEYS.lastCheck, JSON.stringify(result));
    return result;
  }
}

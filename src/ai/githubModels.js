// Client for GitHub Models (free, rate-limited model inference for any
// GitHub account). OpenAI-compatible chat completions endpoint,
// authenticated with a personal access token that has `models:read`.

export const GITHUB_MODELS = {
  id: 'github-models',
  name: 'GitHub Models',
  endpoint: 'https://models.github.ai/inference/chat/completions',
  defaultModel: 'openai/gpt-4.1-mini',
};

/**
 * The model service could not be used (network, token, rate limit,
 * unusable answer). Workflows block with this message instead of failing,
 * so the user can fix the cause and resume.
 */
export class AiUnavailableError extends Error {
  /** @param {'not_configured' | 'auth' | 'rate_limit' | 'network' | 'http' | 'invalid_response'} kind */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
    this.blocking = true;
    this.cause = 'ai_unavailable';
  }
}

/**
 * Extracts a JSON object from a model reply. Models occasionally wrap JSON in
 * a ```json fence even when asked not to.
 */
export function parseJsonReply(text) {
  const trimmed = String(text ?? '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced ? fenced[1] : trimmed;
  try {
    const value = JSON.parse(body);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // fall through
  }
  throw new AiUnavailableError('invalid_response', 'The model did not return a JSON object.');
}

/** A short, token-free description of an unexpected HTTP response, for diagnosis. */
function describeResponse(res, text) {
  const snippet = text.replace(/github_pat_[A-Za-z0-9_]+/g, '[token]').replace(/\s+/g, ' ').trim().slice(0, 160);
  const type = res.headers.get('content-type') || 'none';
  return `HTTP ${res.status}, content-type ${type}${res.redirected ? `, redirected to ${res.url}` : ''}; the response starts with: "${snippet || '(empty)'}"`;
}

/**
 * Some OpenAI-compatible services answer as a server-sent event stream even
 * for non-streaming requests. Reassemble it into a normal completion body.
 */
function parseEventStream(text) {
  let content = '';
  let model;
  let usage;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    const chunk = JSON.parse(data);
    model ??= chunk.model;
    usage = chunk.usage ?? usage;
    content += chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? '';
  }
  return { model, usage, choices: [{ message: { content } }] };
}

export class GitHubModelsClient {
  /**
   * @param {object} options
   * @param {string} options.token
   * @param {string} [options.model]
   * @param {string} [options.endpoint]
   * @param {number} [options.timeoutMs]
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor({ token, model = GITHUB_MODELS.defaultModel, endpoint = GITHUB_MODELS.endpoint, timeoutMs = 90_000, fetchImpl = fetch }) {
    this.token = token;
    this.model = model;
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Sends one chat completion request and returns the parsed JSON reply plus
   * usage information for the activity log.
   *
   * @param {{ system: string, user: string, maxTokens?: number }} prompt
   * @returns {Promise<{ json: object, model: string, durationMs: number, usage: { promptTokens?: number, completionTokens?: number } }>}
   */
  async chatJson({ system, user, maxTokens = 4000 }) {
    if (!this.token) throw new AiUnavailableError('not_configured', 'No GitHub token is configured for GitHub Models.');
    const started = Date.now();
    let res;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        // Headers as in GitHub's documented example for the inference API.
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
          max_tokens: maxTokens,
          stream: false,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error.name === 'TimeoutError' ? `no answer within ${Math.round(this.timeoutMs / 1000)} s` : error.cause?.code ?? error.message;
      throw new AiUnavailableError('network', `GitHub Models could not be reached (${reason}). Check the internet connection.`);
    }

    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new AiUnavailableError('auth', `GitHub Models rejected the token (HTTP ${res.status}). Check that the token is valid and has the "models:read" permission.`);
    }
    if (res.status === 429) {
      const retry = res.headers.get('retry-after');
      throw new AiUnavailableError('rate_limit', `The free GitHub Models limit was reached (HTTP 429)${retry ? `; retry after about ${retry} s` : ''}. Wait, then resume.`);
    }
    if (!res.ok) {
      throw new AiUnavailableError('http', `GitHub Models returned an error: ${describeResponse(res, text)}`);
    }

    let body;
    try {
      body = /^\s*data:/.test(text) ? parseEventStream(text) : JSON.parse(text);
    } catch {
      throw new AiUnavailableError('invalid_response', `GitHub Models returned a response that is not JSON (${describeResponse(res, text)}).`);
    }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content === '') {
      throw new AiUnavailableError('invalid_response', `GitHub Models returned no message content (${describeResponse(res, text)}).`);
    }
    return {
      json: parseJsonReply(content),
      model: body.model ?? this.model,
      durationMs: Date.now() - started,
      usage: { promptTokens: body.usage?.prompt_tokens, completionTokens: body.usage?.completion_tokens },
    };
  }
}

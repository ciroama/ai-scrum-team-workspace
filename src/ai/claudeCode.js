// Client for Claude Code in non-interactive mode (`claude -p`). It uses the
// login of the Claude Code installation on this computer (for example a
// Claude Pro subscription), so no API key is stored in the workspace.
//
// Each request runs `claude` once, in an empty temporary folder, with all
// tools disabled: the model only answers with text, it cannot read or change
// files. The prompt is sent on stdin, the answer is read from the JSON
// result that Claude Code prints.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CLAUDE_CODE = {
  id: 'claude-code',
  name: 'Claude Code',
  defaultModel: 'sonnet',
  // Aliases accepted by `claude --model`; a full model name also works.
  suggestedModels: ['sonnet', 'opus', 'haiku'],
};

/**
 * The model service could not be used (not installed, not logged in, usage
 * limit, timeout, unusable answer). Workflows block with this message
 * instead of failing, so the user can fix the cause and resume.
 */
export class AiUnavailableError extends Error {
  /** @param {'not_configured' | 'auth' | 'rate_limit' | 'timeout' | 'service' | 'invalid_response'} kind */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
    this.blocking = true;
    this.cause = 'ai_unavailable';
  }
}

/**
 * Extracts a JSON object from a model reply. Models occasionally wrap JSON in
 * a ```json fence, or add a sentence around it, even when asked not to.
 */
export function parseJsonReply(text) {
  const trimmed = String(text ?? '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidates = [fenced ? fenced[1] : trimmed];
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start > 0 || (end !== -1 && end < trimmed.length - 1)) candidates.push(trimmed.slice(start, end + 1));
  for (const body of candidates) {
    try {
      const value = JSON.parse(body);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // try the next candidate
    }
  }
  throw new AiUnavailableError('invalid_response', 'The model did not return a JSON object.');
}

const snippet = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || '(empty)';

/** Turns an error reported by Claude Code into a message the user can act on. */
function classify(message, apiStatus) {
  const text = `${message} ${apiStatus ?? ''}`;
  if (apiStatus === 429 || /usage limit|rate limit|limit reached|429/i.test(text)) {
    return new AiUnavailableError('rate_limit', `The Claude usage limit was reached: ${snippet(message)}. Wait until it resets, then resume.`);
  }
  if (apiStatus === 401 || apiStatus === 403 || /log ?in|not logged|authenticat|credential|api key|401|403/i.test(text)) {
    return new AiUnavailableError('auth', `Claude Code is not logged in or the login expired: ${snippet(message)}. Run "claude" in a terminal, log in, then resume.`);
  }
  return new AiUnavailableError('service', `Claude Code reported an error: ${snippet(message)}`);
}

export class ClaudeCodeClient {
  /**
   * @param {object} options
   * @param {string} [options.model]
   * @param {string} [options.binary]  the `claude` command
   * @param {number} [options.timeoutMs]
   */
  constructor({ model = CLAUDE_CODE.defaultModel, binary = 'claude', timeoutMs = 300_000 } = {}) {
    this.model = model;
    this.binary = binary;
    this.timeoutMs = timeoutMs;
  }

  args(system) {
    return [
      '-p',
      '--output-format', 'json',
      '--model', this.model,
      '--system-prompt', system,
      '--tools', '',
      '--strict-mcp-config',
      '--no-session-persistence',
    ];
  }

  /**
   * Sends one request and returns the parsed JSON reply plus usage
   * information for the activity log.
   *
   * @param {{ system: string, user: string }} prompt
   * @returns {Promise<{ json: object, model: string, durationMs: number, usage: { promptTokens?: number, completionTokens?: number } }>}
   */
  async chatJson({ system, user }) {
    const started = Date.now();
    const cwd = await mkdtemp(join(tmpdir(), 'scrum-ai-'));
    let run;
    try {
      run = await this.#run(this.args(system), user, cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }

    let result;
    try {
      result = JSON.parse(run.stdout);
    } catch {
      if (run.exitCode !== 0) throw classify(run.stderr || run.stdout || `exit code ${run.exitCode}`);
      throw new AiUnavailableError('invalid_response', `Claude Code did not print a JSON result: ${snippet(run.stdout)}`);
    }
    if (result.is_error || result.subtype !== 'success') {
      throw classify(result.result || result.subtype || run.stderr || 'unknown error', result.api_error_status);
    }

    const usage = result.usage ?? {};
    const promptTokens =
      usage.input_tokens != null ? usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) : undefined;
    return {
      json: parseJsonReply(result.result),
      model: Object.keys(result.modelUsage ?? {})[0] ?? this.model,
      durationMs: result.duration_ms ?? Date.now() - started,
      usage: { promptTokens, completionTokens: usage.output_tokens },
    };
  }

  #run(args, input, cwd) {
    // Never let an API key in the environment turn this into paid API usage:
    // Claude Code must use its own login (the subscription).
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, this.timeoutMs);
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.stdin.on('error', () => {}); // reported through 'error' or the exit code
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(
          error.code === 'ENOENT'
            ? new AiUnavailableError('not_configured', `Claude Code is not installed on this computer (the "${this.binary}" command was not found).`)
            : new AiUnavailableError('service', `Claude Code could not be started: ${error.message}`),
        );
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new AiUnavailableError('timeout', `Claude Code gave no answer within ${Math.round(this.timeoutMs / 1000)} s.`));
          return;
        }
        resolve({ exitCode, stdout, stderr });
      });
      child.stdin.end(input);
    });
  }
}

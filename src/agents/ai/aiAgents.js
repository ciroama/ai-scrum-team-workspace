// AI-powered agents (Claude Code). They implement the same contracts as
// the scripted agents, so the orchestrator and dashboard treat them alike,
// but every decision here comes from a model, and every model call is
// reported back (aiCalls) so the activity log can show it.
//
// What stays rule-based on purpose:
//  - QA is always scripted: it turns the PO's machine-checkable criteria into
//    deterministic tests, independent of the model that wrote the code.
//  - The PO's final acceptance is the evidence rule (accepted only when QA's
//    checks all passed). It is labelled as rule-based, not as AI.

import { Agent, AgentKind } from '../agent.js';
import { ProductOwnerAgent } from '../productOwner.js';
import { AiUnavailableError } from '../../ai/claudeCode.js';
import { ContractError, WEB_CHECK_TYPES, validateDevReply, validatePoReply } from '../../ai/contracts.js';

export const AI_WEB_RECIPE_ID = 'ai-static-web';

const PRODUCT_SCOPE =
  'The team builds static web pages only: HTML, CSS and browser JavaScript, opened from index.html, ' +
  'with no server, no build step, no frameworks to install and no external resources (no CDNs, no web fonts, no images from the internet).';

/**
 * Calls the model, validates the reply, and retries once with the
 * validation problems if the reply does not match the contract.
 */
async function askWithContract(getClient, { system, user, validate, purpose }) {
  const client = getClient();
  const aiCalls = [];
  let messageForModel = user;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let answer;
    try {
      answer = await client.chatJson({ system, user: messageForModel });
    } catch (error) {
      aiCalls.push({ purpose, attempt, ok: false, model: client.model, error: error.message });
      if (error instanceof AiUnavailableError) error.aiCalls = aiCalls;
      throw error;
    }
    try {
      const value = validate(answer.json);
      aiCalls.push({ purpose, attempt, ok: true, model: answer.model, durationMs: answer.durationMs, usage: answer.usage });
      return { value, aiCalls };
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      aiCalls.push({ purpose, attempt, ok: false, model: answer.model, durationMs: answer.durationMs, usage: answer.usage, error: `Answer rejected: ${error.message}` });
      messageForModel = `${user}\n\nYour previous answer could not be used: ${error.message}\nReturn a corrected JSON object only.`;
    }
  }
  const failure = new AiUnavailableError('invalid_response', `The model's answer did not match the required format twice (${purpose}): ${aiCalls[aiCalls.length - 1].error}`);
  failure.aiCalls = aiCalls;
  throw failure;
}

export class AiProductOwnerAgent extends Agent {
  /** @param {{ getClient: () => import('../../ai/claudeCode.js').ClaudeCodeClient }} deps */
  constructor({ getClient }) {
    const scripted = new ProductOwnerAgent();
    super({ ...scripted.profile, summary: 'Understands your request with an AI model and writes requirements and verifiable acceptance criteria.' }, AgentKind.AI);
    this.getClient = getClient;
    this.rules = scripted;
  }

  async analyse({ requestText }) {
    const system = [
      'You are the Product Owner (PO) of a small software team.',
      PRODUCT_SCOPE,
      'Read the user\'s request and decide:',
      '- If it can be built as such a static web page and is clear enough, answer with status "ready".',
      '- If it cannot be built that way, or an essential detail is missing or contradictory, answer with status "needs_clarification" and ask one clear question.',
      'Rules for "ready":',
      '- Turn EVERY concrete detail the user asked for (texts, colours, layout, behaviour) into its own acceptance criterion. Do not drop details.',
      '- Do not add requirements the user did not ask for.',
      '- Use texts exactly as the user wrote them (same words and capitalisation).',
      '- For colours use CSS colour names or hex codes, e.g. "green" or "#00aa00".',
      '- Every acceptance criterion needs a machine-checkable "check" of one of these types (nothing else is allowed):',
      ...Object.values(WEB_CHECK_TYPES).map((t) => `  * ${t}`),
      'Answer with a JSON object only, in this shape:',
      '{"status":"ready","title":"short product name","summary":"one sentence","requirements":["..."],"acceptanceCriteria":[{"description":"...","check":{...}}],"handoffMessage":"message to the Developer"}',
      'or {"status":"needs_clarification","reason":"ambiguous" | "unsupported","message":"your question to the user"}',
    ].join('\n');

    const { value, aiCalls } = await askWithContract(this.getClient, { system, user: `User request:\n${requestText}`, validate: validatePoReply, purpose: 'analyse the request' });

    if (value.status === 'needs_clarification') {
      return {
        status: 'needs_clarification',
        reason: value.reason,
        supported: [{ id: AI_WEB_RECIPE_ID, title: 'Static web page', summary: PRODUCT_SCOPE }],
        summary: 'The PO (AI) needs clarification before work can start.',
        message: value.message,
        aiCalls,
      };
    }
    const spec = {
      recipeId: AI_WEB_RECIPE_ID,
      title: value.title,
      requestText,
      requirements: value.requirements,
      acceptanceCriteria: value.acceptanceCriteria,
    };
    return {
      status: 'ready',
      spec,
      summary: value.summary
        ? `${value.summary} (${spec.requirements.length} requirements, ${spec.acceptanceCriteria.length} acceptance criteria.)`
        : `Produced ${spec.requirements.length} requirements and ${spec.acceptanceCriteria.length} acceptance criteria for "${spec.title}".`,
      document: { path: 'REQUIREMENTS.md', purpose: 'Requirements and acceptance criteria', content: requirementsMarkdown(spec) },
      handoffMessage:
        value.handoffMessage ??
        `Requirements and ${spec.acceptanceCriteria.length} acceptance criteria for "${spec.title}" are ready. Please implement them so that each criterion can be verified.`,
      aiCalls,
    };
  }

  /** Acceptance is rule-based: accepted only when QA verified every criterion. */
  review(input) {
    return { ...this.rules.review(input), decidedBy: 'rule' };
  }
}

function requirementsMarkdown(spec) {
  return [
    `# Requirements: ${spec.title}`,
    '',
    `Original request: "${spec.requestText}"`,
    '',
    '## Requirements',
    '',
    ...spec.requirements.map((r, i) => `${i + 1}. ${r}`),
    '',
    '## Acceptance criteria',
    '',
    ...spec.acceptanceCriteria.map((c) => `- **${c.id}**: ${c.description}`),
    '',
    '_Written by the AI-powered PO (Claude Code)._',
    '',
  ].join('\n');
}

export class AiDeveloperAgent extends Agent {
  /** @param {{ getClient: () => import('../../ai/claudeCode.js').ClaudeCodeClient }} deps */
  constructor({ getClient }) {
    super(
      {
        id: 'dev',
        label: 'Developer',
        title: 'Developer',
        summary: 'Writes the product files with an AI model and fixes defects reported by QA.',
        responsibilities: ['Implements the requirements', 'Creates and modifies project files', 'Fixes defects reported by QA', 'Hands the implementation to QA'],
      },
      AgentKind.AI,
    );
    this.getClient = getClient;
  }

  async implement({ spec, attempt, defects = [], currentFiles = [] }) {
    const correcting = defects.length > 0;
    const system = [
      'You are the Developer of a small software team.',
      PRODUCT_SCOPE,
      'Implement the requirements so that every acceptance criterion passes. QA will check them with automated tests based on each criterion\'s "check".',
      'Rules:',
      '- The entry page is index.html. Use only relative paths. At most 8 files. Allowed extensions: .html .css .js .svg .md .json .txt.',
      '- Do not write files in the test/ folder: it belongs to QA.',
      '- The page must work when index.html is opened directly from disk: use classic <script src="..."> tags (no type="module"), no fetch of local files, no external URLs.',
      '- Every text a criterion requires must be present in the HTML itself, not only added by JavaScript.',
      '- Use exactly the CSS values stated in the checks (for example the same colour name).',
      'Answer with a JSON object only: {"files":[{"path":"index.html","purpose":"...","content":"..."}],"summary":"what you built","handoffMessage":"message to QA"}',
    ].join('\n');
    const user = JSON.stringify(
      {
        title: spec.title,
        request: spec.requestText,
        requirements: spec.requirements,
        acceptanceCriteria: spec.acceptanceCriteria,
        attempt,
        ...(correcting ? { defectsReportedByQA: defects, currentFiles: currentFiles.map((f) => ({ path: f.path, content: f.content })) } : {}),
      },
      null,
      2,
    );

    const { value, aiCalls } = await askWithContract(this.getClient, {
      system,
      user: correcting ? `Fix the defects reported by QA. Return the complete corrected files.\n${user}` : `Implement this:\n${user}`,
      validate: validateDevReply,
      purpose: correcting ? 'fix the reported defects' : 'implement the requirements',
    });
    return {
      files: value.files,
      summary:
        value.summary ??
        (correcting ? `Correction (attempt ${attempt}): updated ${value.files.length} files.` : `Implemented "${spec.title}": ${value.files.length} files.`),
      handoffMessage: value.handoffMessage ?? `The implementation is ready (${value.files.length} files). Please verify it against the acceptance criteria.`,
      aiCalls,
    };
  }
}

import { ScriptedAgent } from './agent.js';
import { catalogue, normalizeRequest } from '../recipes/index.js';

/**
 * @typedef {object} Spec  agreed requirements, passed PO -> Developer -> QA
 * @property {string} recipeId
 * @property {string} title
 * @property {string} requestText
 * @property {string[]} requirements
 * @property {Array<{ id: string, description: string, check: object }>} acceptanceCriteria
 */

function listOf(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
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
    `_Produced by the scripted PO agent from the "${spec.recipeId}" recipe. No AI model was used._`,
    '',
  ].join('\n');
}

export class ProductOwnerAgent extends ScriptedAgent {
  constructor() {
    super({
      id: 'po',
      label: 'PO',
      title: 'Product Owner',
      summary: 'Turns your request into requirements and acceptance criteria, and reviews the verified result.',
      responsibilities: [
        'Analyses the request',
        'Writes requirements and acceptance criteria',
        'Asks for clarification when a request is unsupported or ambiguous',
        'Reviews the outcome against QA evidence',
      ],
    });
  }

  /**
   * Matches the request against the recipe catalogue.
   *
   * @param {{ requestText: string, recipes: object[] }} input
   * @returns {{ status: 'ready', spec: Spec, summary: string, handoffMessage: string, document: object }
   *         | { status: 'needs_clarification', reason: 'unsupported' | 'ambiguous', summary: string,
   *             message: string, supported: object[] }}
   */
  analyse({ requestText, recipes }) {
    const normalized = normalizeRequest(requestText);
    const supported = catalogue(recipes);
    const supportedList = supported.map((r) => `"${r.title}"`).join(', ');
    const example = supported[0]?.examples[0];

    const recipe = recipes.find((r) => r.matches(normalized));
    if (!recipe) {
      return {
        status: 'needs_clarification',
        reason: 'unsupported',
        supported,
        summary: 'The request does not match a supported request type.',
        message:
          `This request does not match a request type supported in this milestone. ` +
          `Supported request types: ${supportedList}. Please rephrase the request` +
          (example ? `, for example: "${example}"` : '.'),
      };
    }

    const conflicts = recipe.conflicts.filter((c) => c.pattern.test(normalized)).map((c) => c.label);
    if (conflicts.length) {
      return {
        status: 'needs_clarification',
        reason: 'ambiguous',
        supported,
        summary: `The request matches "${recipe.title}" but also asks for ${listOf(conflicts)}.`,
        message:
          `The request matches "${recipe.title}" (${recipe.summary}) but also mentions ${listOf(conflicts)}, ` +
          `which this recipe does not deliver. To avoid building the wrong thing, please confirm by submitting ` +
          `a request without those parts, for example: "${recipe.examples[0]}"`,
      };
    }

    const spec = {
      recipeId: recipe.id,
      title: recipe.title,
      requestText,
      requirements: [...recipe.requirements],
      acceptanceCriteria: recipe.acceptanceCriteria.map((c) => ({ ...c, check: { ...c.check } })),
    };
    return {
      status: 'ready',
      spec,
      summary:
        `Matched the request to "${recipe.title}" and produced ${spec.requirements.length} requirements ` +
        `and ${spec.acceptanceCriteria.length} acceptance criteria.`,
      document: { path: 'REQUIREMENTS.md', purpose: 'Requirements and acceptance criteria', content: requirementsMarkdown(spec) },
      handoffMessage:
        `Requirements and ${spec.acceptanceCriteria.length} acceptance criteria for "${spec.title}" are ready ` +
        `(${spec.acceptanceCriteria.map((c) => c.id).join(', ')}). Please implement them so that each criterion can be verified.`,
    };
  }

  /**
   * Accepts or rejects the outcome, using QA's recorded evidence only.
   *
   * @param {{ spec: Spec, verification: object | null }} input
   * @returns {{ accepted: boolean, summary: string, unmet: string[] }}
   */
  review({ spec, verification }) {
    if (!verification?.executed) {
      return {
        accepted: false,
        unmet: spec.acceptanceCriteria.map((c) => c.id),
        summary: 'Not accepted: there is no QA verification evidence for this implementation.',
      };
    }
    const unmet = spec.acceptanceCriteria
      .filter((c) => verification.criteria.find((r) => r.id === c.id)?.status !== 'pass')
      .map((c) => c.id);
    const accepted = verification.verdict === 'pass' && unmet.length === 0;
    const tests = verification.testSummary;
    return {
      accepted,
      unmet,
      summary: accepted
        ? `Accepted: all ${spec.acceptanceCriteria.length} acceptance criteria are met, verified by QA ` +
          `(${tests.pass} of ${tests.tests} automated tests passed).`
        : `Not accepted: acceptance criteria ${unmet.join(', ')} are not met according to QA's verification.`,
    };
  }
}

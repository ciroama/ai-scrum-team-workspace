import { AgentBlockedError, ScriptedAgent } from './agent.js';
import { getRecipe } from '../recipes/index.js';

/**
 * @typedef {object} Implementation
 * @property {Array<{ path: string, purpose: string, content: string }>} files
 * @property {string} summary
 * @property {string} handoffMessage
 */

export class DeveloperAgent extends ScriptedAgent {
  constructor() {
    super({
      id: 'dev',
      label: 'Developer',
      title: 'Developer',
      summary: 'Implements the agreed requirements as real project files and fixes defects reported by QA.',
      responsibilities: [
        'Implements the requirements',
        'Creates and modifies project files',
        'Fixes defects reported by QA',
        'Hands the implementation to QA',
      ],
    });
  }

  /** The files for a spec. Overridable, e.g. by test doubles. */
  files(spec, _attempt) {
    const recipe = getRecipe(spec.recipeId);
    if (!recipe?.implementation) {
      throw new AgentBlockedError(
        `The scripted Developer has no code template for "${recipe?.title ?? spec.recipeId}". Switch the Developer to AI mode, then resume.`,
        'configuration',
      );
    }
    return recipe.implementation(spec);
  }

  /**
   * @param {{ spec: import('./productOwner.js').Spec, attempt: number, defects: object[] }} input
   * @returns {Implementation}
   */
  implement({ spec, attempt, defects = [] }) {
    const files = this.files(spec, attempt);
    const paths = files.map((f) => f.path).join(', ');
    const correcting = defects.length > 0;
    return {
      files,
      summary: correcting
        ? `Correction (attempt ${attempt}): re-applied the "${spec.title}" code template to address ` +
          `${defects.length} reported defect(s); wrote ${files.length} files.`
        : `Implemented "${spec.title}" from the code template: ${files.length} files (${paths}).`,
      handoffMessage: correcting
        ? `The implementation was updated to address ${defects.map((d) => d.criterionId ?? d.title).join(', ')}. ` +
          `Please re-test it against the acceptance criteria.`
        : `The implementation is ready (${files.length} files). Please verify it against acceptance criteria ` +
          `${spec.acceptanceCriteria.map((c) => c.id).join(', ')}.`,
    };
  }
}

import helloWorld from './helloWorld.js';

/**
 * Supported request types. To add a capability (e.g. a website or a
 * Breakout game), add a recipe module here; the dashboard needs no change.
 */
export const RECIPES = [helloWorld];

/** Lower-cases, strips punctuation and collapses whitespace. */
export function normalizeRequest(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getRecipe(id) {
  return RECIPES.find((recipe) => recipe.id === id) ?? null;
}

/** Public description of the catalogue, for the UI and the PO's replies. */
export function catalogue(recipes = RECIPES) {
  return recipes.map(({ id, title, summary, examples }) => ({ id, title, summary, examples }));
}

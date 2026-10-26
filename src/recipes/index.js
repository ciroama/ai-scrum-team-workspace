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

/**
 * Product type for requirements written by the AI-powered PO: any static web
 * page. It is not matched by the scripted PO; it only tells the platform how
 * to preview the product and what to call it.
 */
export const AI_WEB_RECIPE = {
  id: 'ai-static-web',
  title: 'Web page (AI-powered team)',
  summary: 'Any static web page (HTML, CSS, browser JavaScript), specified by the AI-powered PO.',
  examples: [],
  preview: { type: 'static', entry: 'index.html' },
};

export function getRecipe(id) {
  return [...RECIPES, AI_WEB_RECIPE].find((recipe) => recipe.id === id) ?? null;
}

/** Public description of the catalogue, for the UI and the PO's replies. */
export function catalogue(recipes = RECIPES) {
  return recipes.map(({ id, title, summary, examples }) => ({ id, title, summary, examples }));
}

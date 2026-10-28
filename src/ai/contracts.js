// Validation of model answers. A model reply is only used when it matches
// the agent contract exactly; otherwise the agent retries once and then
// reports the problem. Nothing from a model reply is trusted blindly:
// checks must be of a known, deterministic type and files must stay inside
// the product folder.

/** Check types QA can turn into deterministic tests for a static web page. */
export const WEB_CHECK_TYPES = {
  fileExists: 'A file exists: { "type": "fileExists", "path": "index.html" }',
  fileContains: 'A file contains exact texts: { "type": "fileContains", "path": "index.html", "texts": ["..."] }',
  textVisible: 'Visible page text (HTML without tags, scripts and styles) contains a text: { "type": "textVisible", "path": "index.html", "text": "hello world" }',
  htmlTitle: 'The <title> of index.html equals a text: { "type": "htmlTitle", "text": "..." }',
  cssProperty: 'Some CSS rule (in .css files, <style> blocks or style attributes) sets a property to a value; colours are compared after normalisation: { "type": "cssProperty", "property": "background-color", "value": "green" }',
  centeredLayout: 'The CSS centres content (text-align:center, flex/grid centring or auto margins): { "type": "centeredLayout" }',
};

const ALLOWED_EXTENSIONS = ['.html', '.css', '.js', '.svg', '.md', '.json', '.txt'];
const MAX_FILES = 8;
const MAX_FILE_BYTES = 200_000;

class ContractError extends Error {
  constructor(problems) {
    super(problems.join(' '));
    this.problems = problems;
  }
}
export { ContractError };

const isText = (v, max = 2000) => typeof v === 'string' && v.trim() !== '' && v.length <= max;

function safeRelativePath(path) {
  return (
    typeof path === 'string' &&
    /^[A-Za-z0-9_\-./]+$/.test(path) &&
    !path.startsWith('/') &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..' || part.startsWith('.'))
  );
}

function validateCheck(check, problems, where) {
  if (!check || typeof check !== 'object') return problems.push(`${where}: "check" must be an object.`);
  switch (check.type) {
    case 'fileExists':
      if (!safeRelativePath(check.path)) problems.push(`${where}: fileExists needs a relative "path".`);
      break;
    case 'fileContains':
      if (!safeRelativePath(check.path)) problems.push(`${where}: fileContains needs a relative "path".`);
      if (!Array.isArray(check.texts) || !check.texts.length || !check.texts.every((t) => isText(t, 500))) problems.push(`${where}: fileContains needs a non-empty "texts" array.`);
      break;
    case 'textVisible':
      if (check.path != null && !safeRelativePath(check.path)) problems.push(`${where}: textVisible "path" must be relative.`);
      if (!isText(check.text, 500)) problems.push(`${where}: textVisible needs "text".`);
      break;
    case 'htmlTitle':
      if (!isText(check.text, 200)) problems.push(`${where}: htmlTitle needs "text".`);
      break;
    case 'cssProperty':
      if (!/^[a-z-]{2,40}$/.test(check.property ?? '')) problems.push(`${where}: cssProperty needs a CSS "property" such as "color".`);
      if (!isText(check.value, 100)) problems.push(`${where}: cssProperty needs a "value".`);
      break;
    case 'centeredLayout':
      break;
    default:
      problems.push(`${where}: unknown check type "${check?.type}". Allowed: ${Object.keys(WEB_CHECK_TYPES).join(', ')}.`);
  }
}

/**
 * Validates the PO's reply.
 * @returns {{ status: 'ready', title: string, requirements: string[], acceptanceCriteria: object[], handoffMessage: string, summary: string }
 *         | { status: 'needs_clarification', reason: string, message: string }}
 */
export function validatePoReply(reply) {
  const problems = [];
  if (reply.status === 'needs_clarification') {
    if (!isText(reply.message)) problems.push('"message" (the question for the user) is required.');
    if (problems.length) throw new ContractError(problems);
    return { status: 'needs_clarification', reason: reply.reason === 'unsupported' ? 'unsupported' : 'ambiguous', message: reply.message.trim() };
  }
  if (reply.status !== 'ready') throw new ContractError(['"status" must be "ready" or "needs_clarification".']);
  if (!isText(reply.title, 120)) problems.push('"title" is required (max 120 characters).');
  if (!Array.isArray(reply.requirements) || !reply.requirements.length || reply.requirements.length > 15 || !reply.requirements.every((r) => isText(r, 500))) {
    problems.push('"requirements" must be 1–15 non-empty strings.');
  }
  const criteria = reply.acceptanceCriteria;
  if (!Array.isArray(criteria) || !criteria.length || criteria.length > 12) {
    problems.push('"acceptanceCriteria" must contain 1–12 items.');
  } else {
    criteria.forEach((c, i) => {
      if (!isText(c?.description, 500)) problems.push(`acceptanceCriteria[${i}]: "description" is required.`);
      validateCheck(c?.check, problems, `acceptanceCriteria[${i}]`);
    });
  }
  if (problems.length) throw new ContractError(problems);

  const acceptanceCriteria = criteria.map((c, i) => ({ id: `AC${i + 1}`, description: c.description.trim(), check: normaliseCheck(c.check) }));
  // The entry page is always required; add it if the PO did not state it.
  if (!acceptanceCriteria.some((c) => c.check.type === 'fileExists' && c.check.path === 'index.html')) {
    acceptanceCriteria.push({
      id: `AC${acceptanceCriteria.length + 1}`,
      description: 'The product has an index.html entry page (added by the workspace: the preview and QA need it).',
      check: { type: 'fileExists', path: 'index.html' },
    });
  }
  return {
    status: 'ready',
    title: reply.title.trim(),
    requirements: reply.requirements.map((r) => r.trim()),
    acceptanceCriteria,
    summary: isText(reply.summary, 500) ? reply.summary.trim() : null,
    handoffMessage: isText(reply.handoffMessage, 1000) ? reply.handoffMessage.trim() : null,
    changes: Array.isArray(reply.changes) ? reply.changes.filter((c) => isText(c, 500)).map((c) => c.trim()).slice(0, 20) : null,
  };
}

function normaliseCheck(check) {
  const { type } = check;
  switch (type) {
    case 'fileExists':
      return { type, path: check.path };
    case 'fileContains':
      return { type, path: check.path, texts: check.texts };
    case 'textVisible':
      return { type, path: check.path ?? 'index.html', text: check.text };
    case 'htmlTitle':
      return { type, path: 'index.html', text: check.text.trim() };
    case 'cssProperty':
      return { type, property: check.property, value: check.value.trim() };
    default:
      return { type };
  }
}

/**
 * Validates the PO's acceptance decision. The PO may reject a product whose
 * tests pass, but never accept one that QA did not verify.
 * @param {object} reply
 * @param {{ qaPassed: boolean }} context
 * @returns {{ accepted: boolean, summary: string, reasons: string[] }}
 */
export function validateReviewReply(reply, { qaPassed }) {
  const problems = [];
  if (reply.decision !== 'accept' && reply.decision !== 'reject') problems.push('"decision" must be "accept" or "reject".');
  if (!isText(reply.summary, 800)) problems.push('"summary" (one or two sentences for the user) is required.');
  if (reply.decision === 'accept' && !qaPassed) problems.push('QA did not verify every acceptance criterion, so the only allowed decision is "reject".');
  if (problems.length) throw new ContractError(problems);
  return {
    accepted: reply.decision === 'accept',
    summary: reply.summary.trim(),
    reasons: Array.isArray(reply.reasons) ? reply.reasons.filter((r) => isText(r, 500)).map((r) => r.trim()).slice(0, 10) : [],
  };
}

/**
 * Validates the Developer's reply.
 * @returns {{ files: Array<{ path: string, purpose: string, content: string }>, summary: string | null, handoffMessage: string | null }}
 */
export function validateDevReply(reply) {
  const problems = [];
  const files = reply.files;
  if (!Array.isArray(files) || !files.length) {
    throw new ContractError(['"files" must be a non-empty array.']);
  }
  if (files.length > MAX_FILES) problems.push(`At most ${MAX_FILES} files are allowed.`);
  const seen = new Set();
  files.forEach((f, i) => {
    const where = `files[${i}]`;
    if (!safeRelativePath(f?.path)) problems.push(`${where}: "path" must be a simple relative path (no "..", no hidden files).`);
    else {
      if (seen.has(f.path)) problems.push(`${where}: duplicate path ${f.path}.`);
      seen.add(f.path);
      if (f.path.startsWith('test/')) problems.push(`${where}: the test/ folder is reserved for QA.`);
      if (!ALLOWED_EXTENSIONS.some((ext) => f.path.toLowerCase().endsWith(ext))) problems.push(`${where}: only ${ALLOWED_EXTENSIONS.join(' ')} files are allowed.`);
    }
    if (typeof f?.content !== 'string') problems.push(`${where}: "content" must be a string.`);
    else if (Buffer.byteLength(f.content) > MAX_FILE_BYTES) problems.push(`${where}: file is larger than ${MAX_FILE_BYTES} bytes.`);
    else if (/\b(src|href)\s*=\s*["']\s*(https?:)?\/\//i.test(f.content) || /@import\s+url\(\s*["']?https?:/i.test(f.content)) {
      problems.push(`${where}: external resources (http/https URLs) are not allowed; the page must work offline.`);
    }
  });
  if (!seen.has('index.html')) problems.push('index.html is required.');
  if (problems.length) throw new ContractError(problems);
  return {
    files: files.map((f) => ({ path: f.path, purpose: isText(f.purpose, 200) ? f.purpose.trim() : 'Product file', content: f.content })),
    summary: isText(reply.summary, 800) ? reply.summary.trim() : null,
    handoffMessage: isText(reply.handoffMessage, 1000) ? reply.handoffMessage.trim() : null,
  };
}

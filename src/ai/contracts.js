import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
 *
 * Refinement rules: questions are structured (what, why it matters, options).
 * On the first round, before the user has answered anything, the PO may not
 * decide anything the user did not say: every assumption must come from the
 * user, and the PO must explain why the request needs no questions.
 *
 * @param {object} reply
 * @param {{ firstRound?: boolean }} [context]
 * @returns {{ status: 'ready', title: string, requirements: string[], acceptanceCriteria: object[], assumptions: object[], handoffMessage: string, summary: string }
 *         | { status: 'needs_clarification', reason: string, message: string, questions: object[] }}
 */
export function validatePoReply(reply, { firstRound = false } = {}) {
  const problems = [];
  if (reply.status === 'needs_clarification') {
    const questions = Array.isArray(reply.questions) ? reply.questions : [];
    if (!questions.length && !isText(reply.message)) problems.push('"questions" (what you need to know from the user) is required.');
    if (questions.length > 8) problems.push('Ask at most 8 questions at a time.');
    questions.forEach((q, i) => {
      if (!isText(q?.question, 500)) problems.push(`questions[${i}]: "question" is required.`);
      if (q?.options != null && (!Array.isArray(q.options) || !q.options.every((o) => isText(o, 200)))) problems.push(`questions[${i}]: "options" must be a list of short texts.`);
    });
    if (problems.length) throw new ContractError(problems);
    const clean = questions.map((q) => ({
      question: q.question.trim(),
      why: isText(q.why, 500) ? q.why.trim() : null,
      options: Array.isArray(q.options) ? q.options.map((o) => o.trim()) : [],
    }));
    const intro = isText(reply.message) ? reply.message.trim() : null;
    const message = clean.length
      ? [intro ?? 'Before I write the requirements, I need to know:', ...clean.map((q, i) => `${i + 1}. ${q.question}${q.options.length ? ` (${q.options.join(' / ')})` : ''}`)].join('\n')
      : intro;
    return { status: 'needs_clarification', reason: reply.reason === 'unsupported' ? 'unsupported' : 'ambiguous', message, questions: clean };
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
  if (!Array.isArray(reply.assumptions)) {
    problems.push('"assumptions" is required: list every detail you rely on that the request does not state word for word, with "decidedBy": "user" or "po" (an empty list if there are none).');
  } else {
    reply.assumptions.forEach((a, i) => {
      if (!isText(a?.text, 500)) problems.push(`assumptions[${i}]: "text" is required.`);
      if (a?.decidedBy !== 'user' && a?.decidedBy !== 'po') problems.push(`assumptions[${i}]: "decidedBy" must be "user" or "po".`);
    });
    if (firstRound) {
      const decided = reply.assumptions.filter((a) => a?.decidedBy === 'po').map((a) => a.text);
      if (decided.length) {
        problems.push(`You decided details the user never gave (${decided.join('; ')}). The user has not answered anything yet: ask instead of deciding (status "needs_clarification").`);
      }
      if (!isText(reply.whyNoQuestions, 800)) {
        problems.push('Before writing requirements without asking anything, explain in "whyNoQuestions" why the request leaves nothing open; if anything is open, ask instead.');
      }
    }
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
    assumptions: reply.assumptions.map((a) => ({ text: a.text.trim(), decidedBy: a.decidedBy })),
    whyNoQuestions: isText(reply.whyNoQuestions, 800) ? reply.whyNoQuestions.trim() : null,
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
      if (f.path.startsWith('test/') || f.path.startsWith('qa/')) problems.push(`${where}: the test/ and qa/ folders are reserved for QA.`);
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

/** Where QA's AI-written tests live: outside test/, so `node --test` does not pick them up unprotected. */
export const QA_AI_TEST_FILE = 'qa/ai-checks.mjs';
const QA_ALLOWED_MODULES = ['node:test', 'node:assert', 'node:assert/strict', 'node:fs', 'node:path', 'node:vm', 'node:module', 'node:url'];

/** Whether a JavaScript module parses, using Node itself. */
function syntaxError(source) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-check-'));
  try {
    const file = join(dir, 'check.mjs');
    writeFileSync(file, source);
    const run = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 10_000 });
    return run.status === 0 ? null : (run.stderr || 'syntax error').split('\n').filter(Boolean).slice(0, 4).join(' ');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Validates QA's own tests and concerns. The tests run later with read-only
 * access to the product folder; this check keeps them to a known set of
 * modules and makes sure they parse.
 * @returns {{ testFile: string, tests: number, concerns: string[], summary: string | null }}
 */
export function validateQaReply(reply) {
  const problems = [];
  const source = reply.testFile;
  if (typeof source !== 'string' || !source.trim()) problems.push('"testFile" (an ES module using node:test) is required.');
  else {
    if (Buffer.byteLength(source) > 100_000) problems.push('"testFile" is larger than 100 KB.');
    const tests = source.match(/\btest\s*\(\s*(['"`])QA-AI: /g) ?? [];
    if (!tests.length) problems.push('Name every test "QA-AI: ...", e.g. test(\'QA-AI: the score increases when a brick breaks\', ...).');
    const modules = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"`])([^'"`]+)\1/g)].map((m) => m[2]);
    const imported = [...source.matchAll(/^\s*import\s+(['"])([^'"]+)\1/gm)].map((m) => m[2]);
    const bad = [...modules, ...imported].filter((m) => !QA_ALLOWED_MODULES.includes(m) && !/^\.{1,2}\//.test(m));
    if (bad.length) problems.push(`Only these modules may be used: ${QA_ALLOWED_MODULES.join(', ')}, or product files by relative path. Not allowed: ${[...new Set(bad)].join(', ')}.`);
    if (/\b(fetch|XMLHttpRequest|WebSocket|process\.binding|process\.dlopen)\b/.test(source)) problems.push('No network access or native bindings in tests.');
    if (!problems.length) {
      const error = syntaxError(source);
      if (error) problems.push(`The test file does not parse: ${error}`);
    }
  }
  if (reply.concerns != null && (!Array.isArray(reply.concerns) || !reply.concerns.every((c) => isText(c, 600)))) problems.push('"concerns" must be a list of short texts.');
  if (problems.length) throw new ContractError(problems);
  return {
    testFile: source,
    tests: (source.match(/\btest\s*\(\s*(['"`])QA-AI: /g) ?? []).length,
    concerns: (reply.concerns ?? []).map((c) => c.trim()).slice(0, 10),
    summary: isText(reply.summary, 600) ? reply.summary.trim() : null,
  };
}

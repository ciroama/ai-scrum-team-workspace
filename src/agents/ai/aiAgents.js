// AI-powered agents (Claude Code). They implement the same contracts as
// the scripted agents, so the orchestrator and dashboard treat them alike,
// but every decision here comes from a model, and every model call is
// reported back (aiCalls) so the activity log can show it.
//
// What stays independent of the model on purpose:
//  - QA's deterministic checks always run, also when QA is AI-powered: they
//    turn the PO's machine-checkable criteria into tests no model can talk
//    round. An AI-powered QA only adds its own tests and concerns.
//  - The PO's final review is a model decision, but it can only reject what
//    QA did not verify; it can never accept it.

import { Agent, AgentBlockedError, AgentKind } from '../agent.js';
import { ProductOwnerAgent } from '../productOwner.js';
import { AiUnavailableError } from '../../ai/claudeCode.js';
import { ContractError, MAX_CRITERIA, MAX_REQUIREMENTS, MAX_TEAM_QUESTIONS, QA_AI_TEST_FILE, WEB_CHECK_TYPES, validateDevReply, validatePoReply, validateQaReply, validateReviewReply, validateTeamAnswerReply } from '../../ai/contracts.js';
import { QaAgent } from '../qa.js';
import { roleInstructions } from '../scrumRoles.js';

export const AI_WEB_RECIPE_ID = 'ai-static-web';

const PRODUCT_SCOPE =
  'The team builds static web pages only: HTML, CSS and browser JavaScript, opened from index.html, ' +
  'with no server, no build step, no frameworks to install and no external resources (no CDNs, no web fonts, no images from the internet).';

/** What a Developer or QA is told about asking the PO before doing its work. */
function askingRules(canAsk, deliverWhat) {
  return canAsk
    ? [
        `You may ask the PO questions before you ${deliverWhat}, once for this piece of work. Ask when something you need is missing, vague or contradictory in the requirements and the answer would change what you do.`,
        `To ask, answer instead with {"status":"questions","questions":[{"question":"...","why":"what it changes in your work"}]} (at most ${MAX_TEAM_QUESTIONS}). The PO answers, or passes the question on to the user. Do not ask about things you can reasonably decide yourself.`,
      ]
    : ['You have already asked the PO your questions for this piece of work (the answers are in "teamClarifications"), or asking is not possible now: do not ask again.'];
}

/** The answers the team already got to its questions, for every agent that works on the request. */
const clarificationsFor = (teamClarifications) => (teamClarifications?.length ? { teamClarifications: teamClarifications.map(({ from, question, answer, answeredBy }) => ({ askedBy: from === 'dev' ? 'Developer' : 'QA', question, answer, answeredBy: answeredBy === 'user' ? 'the user' : 'the PO' })) } : {});

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

  async analyse({ requestText, current = null, dialogue = [], requestType = null }) {
    const bug = Boolean(current) && requestType === 'bug';
    const system = [
      'You are the Product Owner (PO) of a small software team.',
      ...roleInstructions('po'),
      PRODUCT_SCOPE,
      'Behave like a real PO in backlog refinement: never build on guesses. Before writing requirements, look for everything the request leaves open: what exactly it is, scope, content and texts, look and layout, behaviour and rules, controls, states (start, end, errors, empty), edge cases, and how success is judged.',
      'When anything that matters is open, stop and ask (status "needs_clarification"): several numbered questions at once, each with why it matters and, where useful, a few options. A short request like "build a game" always needs questions.',
      'Only the user decides. If the user answers "you decide" (or similar) about something, you may decide it, and you record it as an assumption with "decidedBy": "po".',
      ...(bug
        ? [
            'The product already exists. You receive its current requirements and acceptance criteria, and a BUG REPORT from the user: something does not work as agreed or as expected.',
            '- Do not add new features. Keep every requirement and criterion as it is, unless the bug shows one is missing or wrong: then fix it and list it in "changes".',
            '- Add an acceptance criterion that checks the bug is fixed, when it can be checked.',
            '- Say where the bug comes from in "bugOrigin": "requirements" (the agreed requirements missed or misstated it) or "implementation" (the requirements were right, the code is wrong).',
            '- Return the COMPLETE lists. If the report is unclear (what happens, when, what was expected), ask first.',
          ]
        : []),
      ...(current && !bug
        ? [
            'The product already exists. You receive its current requirements and acceptance criteria, and a change request from the user.',
            'Apply the change request to the current requirements:',
            '- Keep every current requirement and criterion that the change does not touch, unchanged.',
            '- Modify the ones the change affects, remove the ones it contradicts, and add new ones for what it asks.',
            '- Return the COMPLETE updated lists (not only the changes), and list what you did in "changes", e.g. "Changed: the text colour is now blue (was red)".',
            '- If the change request is unclear or leaves something open, or cannot be built as such a static web page, answer with status "needs_clarification" and ask.',
          ]
        : current
          ? []
          : [
            'Read the user\'s request and decide:',
            '- If it can be built as such a static web page and nothing that matters is left open, answer with status "ready".',
            '- If it cannot be built that way, or anything that matters is missing, vague or contradictory, answer with status "needs_clarification" and ask.',
          ]),
      'If a clarification dialogue is included, the user\'s answers complete the request: use them together with the request, and do not ask again about anything already answered. Ask again only about what is still open.',
      'Rules for "ready":',
      '- Turn EVERY concrete detail the user asked for (texts, colours, layout, behaviour) into its own acceptance criterion. Do not drop details.',
      '- Do not add requirements the user did not ask for.',
      '- List in "assumptions" every detail you rely on that the request does not state word for word, each with "decidedBy": "user" (the user said it, in the request or an answer) or "po" (you decided because the user asked you to).',
      dialogue.length
        ? '- The user has answered questions, so "decidedBy": "po" is allowed for what the user left to you.'
        : '- The user has not answered anything yet: every assumption must be "decidedBy": "user", and "whyNoQuestions" must explain why nothing is left open. Otherwise ask.',
      '- Write requirements and acceptance criteria as the user would: what the user sees, does and gets. Never name files, functions, variables, code structure, libraries, CSS or other technical choices: how to build it is the Developer\'s decision, and how to test it is QA\'s.',
      '- Each acceptance criterion is one sentence a person can check by using the product (e.g. "When Abel touches a cat, the game ends and the final score is shown"). QA turns every criterion into automated tests; you do not write tests.',
      '- Use texts exactly as the user wrote them (same words and capitalisation).',
      '- Name colours precisely, e.g. "green" or "#00aa00".',
      `- At most ${MAX_REQUIREMENTS} requirements and ${MAX_CRITERIA} acceptance criteria, each under 1000 characters. They describe the whole product, so merge overlapping ones rather than only adding.`,
      'Answer with a JSON object only, in this shape:',
      current
        ? '{"status":"ready","title":"short product name","summary":"one sentence","changes":["Added: ...","Changed: ...","Removed: ..."],' + (bug ? '"bugOrigin":"requirements" | "implementation",' : '') + '"requirements":["..."],"acceptanceCriteria":[{"description":"..."}],"assumptions":[{"text":"...","decidedBy":"user" | "po"}],"whyNoQuestions":"only when the user has not answered anything yet","handoffMessage":"message to the Developer"}'
        : '{"status":"ready","title":"short product name","summary":"one sentence","requirements":["..."],"acceptanceCriteria":[{"description":"..."}],"assumptions":[{"text":"...","decidedBy":"user" | "po"}],"whyNoQuestions":"only when the user has not answered anything yet","handoffMessage":"message to the Developer"}',
      'or {"status":"needs_clarification","reason":"ambiguous" | "unsupported","message":"one short sentence for the user","questions":[{"question":"...","why":"why it matters","options":["...","..."]}]}',
    ].join('\n');
    const user = current
      ? JSON.stringify(
          {
            currentRequirements: { version: current.version, title: current.spec.title, requirements: current.spec.requirements, acceptanceCriteria: current.spec.acceptanceCriteria },
            ...(bug ? { bugReport: requestText } : { changeRequest: requestText }),
            ...(dialogue.length ? { clarificationDialogue: dialogue } : {}),
          },
          null,
          2,
        )
      : `User request:\n${requestText}` +
        (dialogue.length
          ? `\n\nClarification dialogue so far (your questions and the user's answers):\n${dialogue.map((d, i) => `${i + 1}. PO: ${d.question}\n   User: ${d.answer}`).join('\n')}`
          : '');

    const { value, aiCalls } = await askWithContract(this.getClient, {
      system,
      user,
      validate: (reply) => validatePoReply(reply, { firstRound: dialogue.length === 0, bug }),
      purpose: bug ? 'analyse the bug report' : current ? 'apply the change request to the requirements' : 'analyse the request',
    });

    if (value.status === 'needs_clarification') {
      return {
        status: 'needs_clarification',
        reason: value.reason,
        supported: [{ id: AI_WEB_RECIPE_ID, title: 'Static web page', summary: PRODUCT_SCOPE }],
        summary: 'The PO (AI) needs clarification before work can start.',
        message: value.message,
        questions: value.questions,
        aiCalls,
      };
    }
    const spec = {
      recipeId: AI_WEB_RECIPE_ID,
      title: value.title,
      requestText,
      requirements: value.requirements,
      acceptanceCriteria: value.acceptanceCriteria,
      version: (current?.version ?? 0) + 1,
      assumptions: value.assumptions,
      ...(dialogue.length ? { clarifications: dialogue } : {}),
      ...(current ? { changes: value.changes ?? [], requestType: bug ? 'bug' : 'change' } : {}),
      ...(bug ? { bugOrigin: value.bugOrigin } : {}),
      // Why the PO wrote the requirements without asking you anything.
      ...(!dialogue.length && value.whyNoQuestions ? { whyNoQuestions: value.whyNoQuestions } : {}),
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

  /**
   * The acceptance decision, made by the model from the request, the agreed
   * requirements and QA's evidence. Like a real PO it never reads the code:
   * whether the code is right is for QA to show. Guard: it may reject a
   * product whose tests pass, but cannot accept one QA did not verify.
   */
  async review({ spec, verification, previousRejections = [], teamClarifications = [] }) {
    const evidence = this.rules.review({ spec, verification });
    const qaPassed = Boolean(verification?.executed && verification.verdict === 'pass' && evidence.unmet.length === 0);
    const system = [
      'You are the Product Owner (PO) of a small software team, doing the final review of an increment.',
      ...roleInstructions('po'),
      'You receive the user\'s request, the agreed requirements and acceptance criteria, and the result of QA\'s verification. You do not see the code: as a PO you judge the product by the request, the requirements and QA\'s evidence, never by reading the implementation.',
      'Decide whether to accept the product:',
      '- Accept only if it does what the user asked and every acceptance criterion was verified by QA.',
      '- Reject if QA did not verify every criterion, or if QA\'s evidence shows the product does not really do what the user asked (even when the tests pass). Explain why, with concrete reasons the Developer can act on: a rejected product goes back to the Developer for rework.',
      '- If you rejected earlier versions, check whether your reasons were addressed. Do not invent new demands beyond the request and the requirements.',
      '- If QA raised concerns that the requirements may not match the request, weigh them against the request: reject if the product misses what the user asked.',
      qaPassed ? 'QA verified every acceptance criterion.' : 'QA did NOT verify every acceptance criterion: you must reject.',
      '- For every reason to reject, say where the problem comes from: "requirements" (the agreed requirements missed or misstated what the user asked) or "implementation" (the code does not do what the requirements say).',
      '- If QA raised concerns, answer each one explicitly: do you agree that the requirements may not match the request, and why.',
      'Answer with a JSON object only: {"decision":"accept" | "reject","summary":"one or two sentences for the user","reasons":[{"text":"...","origin":"requirements" | "implementation"}],"concernResponses":[{"concern":1,"decision":"agree" | "disagree","reason":"..."}]}',
    ].join('\n');
    const user = JSON.stringify(
      {
        request: spec.requestText,
        requirements: spec.requirements,
        acceptanceCriteria: spec.acceptanceCriteria.map(({ id, description }) => ({ id, description })),
        qaVerification: verification
          ? {
              executed: verification.executed,
              verdict: verification.verdict,
              criteria: verification.criteria,
              tests: verification.testSummary,
              qaOwnTests: verification.aiTests ?? null,
              openDefects: verification.defects?.map((d) => d.title) ?? [],
              qaConcerns: verification.concerns ?? [],
            }
          : { executed: false },
        ...clarificationsFor(teamClarifications),
        ...(previousRejections.length ? { yourPreviousRejections: previousRejections } : {}),
      },
      null,
      2,
    );
    const { value, aiCalls } = await askWithContract(this.getClient, {
      system,
      user,
      validate: (reply) => validateReviewReply(reply, { qaPassed, concerns: verification?.concerns ?? [] }),
      purpose: 'review the verified outcome',
    });
    return {
      accepted: value.accepted,
      summary: value.summary,
      reasons: value.reasons,
      reasonOrigins: value.reasonOrigins,
      concernResponses: value.concernResponses,
      unmet: evidence.unmet,
      decidedBy: 'ai',
      aiCalls,
    };
  }

  /**
   * Answers the questions a Developer or QA asked before doing their work,
   * from the request, the agreed requirements and what the user already
   * said. What only the user can decide is passed on to the user.
   */
  async answerTeam({ spec, from, questions, dialogue = [], teamClarifications = [] }) {
    const asker = from === 'dev' ? 'Developer' : 'QA';
    const system = [
      'You are the Product Owner (PO) of a small software team.',
      ...roleInstructions('po'),
      `The ${asker} asked you questions before doing their work. Answer each one as the PO: from the user's request, the agreed requirements, the assumptions and everything the user already told you.`,
      '- Answer yourself when the answer follows from what is agreed, or is a product detail the user left to you ("you decide").',
      '- Pass a question on to the user ("askUser": true) when only the user can decide it: it changes what the user gets and nothing agreed so far settles it. Say why in "why".',
      '- Do not invent requirements the user never asked for. Keep answers short and concrete.',
      'Answer with a JSON object only: {"answers":[{"question":1,"answer":"..."},{"question":2,"askUser":true,"why":"..."}]}',
    ].join('\n');
    const user = JSON.stringify(
      {
        request: spec.requestText,
        requirements: spec.requirements,
        acceptanceCriteria: spec.acceptanceCriteria.map(({ id, description }) => ({ id, description })),
        assumptions: spec.assumptions ?? [],
        clarificationDialogueWithUser: dialogue,
        ...clarificationsFor(teamClarifications),
        [`questionsFrom${asker === 'QA' ? 'QA' : 'Developer'}`]: questions.map((q, i) => ({ number: i + 1, ...q })),
      },
      null,
      2,
    );
    const { value, aiCalls } = await askWithContract(this.getClient, {
      system,
      user,
      validate: (reply) => validateTeamAnswerReply(reply, { count: questions.length }),
      purpose: `answer the ${asker}'s questions`,
    });
    return { answers: value.answers, decidedBy: 'ai', aiCalls };
  }
}

function requirementsMarkdown(spec) {
  return [
    `# Requirements: ${spec.title} (version ${spec.version})`,
    '',
    spec.changes ? `Change request: "${spec.requestText}"` : `Original request: "${spec.requestText}"`,
    '',
    ...(spec.assumptions?.length
      ? ['## Assumptions', '', ...spec.assumptions.map((a) => `- ${a.text} (${a.decidedBy === 'po' ? 'decided by the PO, as you asked' : 'from you'})`), '']
      : []),
    ...(spec.clarifications ? ['## Clarifications', '', ...spec.clarifications.flatMap((d) => [`- PO: ${d.question}`, `  You: ${d.answer}`]), ''] : []),
    ...(spec.changes ? ['## Changes in this version', '', ...(spec.changes.length ? spec.changes.map((c) => `- ${c}`) : ['- (none listed)']), ''] : []),
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
        summary: 'Writes the product files with an AI model and fixes the problems reported by QA or the PO.',
        responsibilities: ['Decides how to build what the PO asks', 'Asks the PO when what to build is unclear', 'Fixes defects reported by QA and rework asked by the PO', 'Meets the Definition of Done before handing over to QA'],
      },
      AgentKind.AI,
    );
    this.getClient = getClient;
  }

  async implement({ spec, attempt, defects = [], currentFiles = [], change = null, canAsk = false, teamClarifications = [] }) {
    const correcting = defects.length > 0;
    const system = [
      'You are the Developer of a small software team.',
      ...roleInstructions('dev'),
      PRODUCT_SCOPE,
      'Implement the requirements so that every acceptance criterion is met. QA turns each criterion into automated tests and checks it.',
      ...(change && !correcting
        ? ['The product already exists: you receive its current files and the updated requirements. Change the existing files so the product meets the updated requirements, and keep everything else as it is. Return the complete content of every file you change, and always index.html; files you do not return stay as they are.']
        : []),
      'Rules:',
      '- The entry page is index.html. Use only relative paths. At most 8 files. Allowed extensions: .html .css .js .svg .md .json .txt.',
      '- Do not write files in the test/ folder: it belongs to QA.',
      '- The page must work when index.html is opened directly from disk: use classic <script src="..."> tags (no type="module"), no fetch of local files, no external URLs.',
      '- Every text a criterion requires must be present in the HTML itself, not only added by JavaScript.',
      '- Keep behaviour testable without a browser: put rules, state changes and calculations in plain functions in a .js file, and at its end export them for Node with: if (typeof module !== "undefined") module.exports = { ... }; QA may test them.',
      '- Use exactly the values the requirements state (for example the same colour name or text).',
      ...askingRules(canAsk, 'write the code'),
      'Answer with a JSON object only: {"files":[{"path":"index.html","purpose":"...","content":"..."}],"summary":"what you built","handoffMessage":"message to QA"}',
    ].join('\n');
    const user = JSON.stringify(
      {
        title: spec.title,
        request: spec.requestText,
        requirements: spec.requirements,
        acceptanceCriteria: spec.acceptanceCriteria,
        attempt,
        ...clarificationsFor(teamClarifications),
        ...(change && !correcting ? { changesToRequirements: spec.changes ?? [], currentFiles: currentFiles.map((f) => ({ path: f.path, content: f.content })) } : {}),
        ...(correcting
          ? {
              problemsReported: defects.map((d) => ({ reportedBy: d.reportedBy ?? 'QA', ...d })),
              currentFiles: currentFiles.map((f) => ({ path: f.path, content: f.content })),
            }
          : {}),
      },
      null,
      2,
    );

    const { value, aiCalls } = await askWithContract(this.getClient, {
      system,
      user: correcting
        ? `Fix the problems reported by QA (failed checks) or by the PO (the product does not do what was asked). Return the complete corrected files.\n${user}`
        : change
          ? `Change the existing product to meet the updated requirements:\n${user}`
          : `Implement this:\n${user}`,
      validate: (reply) => validateDevReply(reply, { canAsk }),
      purpose: correcting ? (defects.some((d) => d.reportedBy === 'PO') ? "rework what the PO rejected" : 'fix the reported defects') : change ? 'implement the change request' : 'implement the requirements',
    });
    if (value.status === 'questions') return { status: 'questions', questions: value.questions, aiCalls };
    return {
      status: 'delivered',
      files: value.files,
      summary:
        value.summary ??
        (correcting ? `Correction (attempt ${attempt}): updated ${value.files.length} files.` : `Implemented "${spec.title}": ${value.files.length} files.`),
      handoffMessage: value.handoffMessage ?? `The implementation is ready (${value.files.length} files). Please verify it against the acceptance criteria.`,
      aiCalls,
    };
  }
}

/**
 * AI-powered QA. It runs the same deterministic checks as the scripted QA
 * (they cannot be skipped), and adds its own: tests written by the model from
 * the user's request and the clarification dialogue, not only from the PO's
 * criteria, plus concerns when the requirements may not match the request.
 * Its tests run with read-only access to the product folder (the
 * orchestrator enforces that), and they can only add defects, never remove
 * the deterministic ones.
 */
export class AiQaAgent extends Agent {
  /** @param {{ getClient: () => import('../../ai/claudeCode.js').ClaudeCodeClient }} deps */
  constructor({ getClient }) {
    const scripted = new QaAgent();
    super(
      {
        ...scripted.profile,
        summary: 'Runs the deterministic acceptance checks, then writes and runs its own tests with an AI model, from your request and answers, and flags requirements that may not match.',
        responsibilities: ['Decides how each acceptance criterion is tested, and writes the tests', 'Asks the PO when what is wanted is unclear', 'Reports defects to the Developer and concerns to the PO, with evidence', 'Holds the team to the Definition of Done; re-tests every correction'],
      },
      AgentKind.AI,
    );
    this.getClient = getClient;
    this.rules = scripted;
  }

  async planVerification({ spec, implementation, dialogue = [], files = [], canAsk = false, teamClarifications = [] }) {
    // The PO writes its criteria in words: QA decides how to test each one.
    const toTest = spec.acceptanceCriteria.filter((c) => !c.check);
    const system = [
      'You are the QA engineer of a small software team.',
      ...roleInstructions('qa'),
      'Criteria that already come with a check (the workspace\'s own rules, such as the entry page) are tested deterministically and always run.',
      'Besides testing every criterion, look for what the criteria miss: a few additional tests from the USER\'S ORIGINAL REQUEST and the clarification dialogue, and concerns for the PO where the requirements may not match what the user asked.',
      'Be economical, like a tester with limited time: prefer a deterministic check (one line) whenever one fits; write a test of your own only when no check fits; at most one test per criterion and at most 3 additional tests from the request; keep every test short, with no comments and no helper code you do not need.',
      PRODUCT_SCOPE,
      'Write ONE ES module (it will be saved as ' + QA_AI_TEST_FILE + ' and run with `node --test-reporter=tap` from the product folder) that:',
      '- uses node:test (`import { test } from "node:test"`) and node:assert/strict; it may also use node:fs, node:path, node:vm, node:module and node:url, and nothing else;',
      '- names every test "QA-AI: <what it checks>";',
      '- reads product files relative to process.cwd() (the product folder); it has READ-ONLY access, no network and cannot start processes;',
      '- tests behaviour where the files allow it: plain .js files that export functions for Node can be loaded with createRequire(import.meta.url)("../file.js"); otherwise check the HTML, CSS and scripts as text;',
      '- tests what the user asked for, concretely, without duplicating the existing acceptance tests and without testing things nobody asked for.',
      'A failing test means a defect the Developer must fix, so only assert what the request or the answers really require.',
      ...(toTest.length
        ? [
            `The PO wrote the acceptance criteria ${toTest.map((c) => c.id).join(', ')} in words: you turn EACH of them into automated tests. For each one, either:`,
            '- give it a deterministic check in "criteriaChecks" when one of these fits exactly:',
            ...Object.values(WEB_CHECK_TYPES).map((t) => `    * ${t}`),
            '- or, only when no check fits, write one test of your own named "QA-AI: AC<n> <what it checks>" (e.g. "QA-AI: AC3 the game ends when Abel touches a cat"); the criterion passes only if its test passes.',
            'Test what the criterion says the user gets, through the behaviour the files allow you to run, rather than how the code happens to be written.',
          ]
        : []),
      'List in "requestOnly" the names of your tests that check something the user asked (in the request or the answers) that the agreed requirements do not state: if such a test fails, the requirements missed it too.',
      ...askingRules(canAsk, 'write your tests'),
      `Answer with a JSON object only: {"summary":"what your tests cover","testFile":"<the whole module source>",${toTest.length ? '"criteriaChecks":[{"criterion":"AC1","check":{...}}],' : ''}"requestOnly":["QA-AI: ..."],"concerns":["a requirement that may not match the request, and why"]}`,
    ].join('\n');
    const user = JSON.stringify(
      {
        request: spec.requestText,
        clarificationDialogue: dialogue,
        requirements: spec.requirements,
        acceptanceCriteria: spec.acceptanceCriteria.map(({ id, description }) => ({ id, description })),
        assumptions: spec.assumptions ?? [],
        ...clarificationsFor(teamClarifications),
        files: files.map((f) => ({ path: f.path, content: f.content })),
      },
      null,
      2,
    );
    const { value, aiCalls } = await askWithContract(this.getClient, {
      system,
      user,
      validate: (reply) => validateQaReply(reply, { canAsk, criteria: toTest.map(({ id, description }) => ({ id, description })) }),
      purpose: 'write QA tests from the request',
    });
    if (value.status === 'questions') return { status: 'questions', questions: value.questions, aiCalls };
    // Deterministic tests for the criteria that have a check (QA's choice, or a rule of the workspace).
    const checked = spec.acceptanceCriteria.filter((c) => c.check || value.criteriaChecks[c.id]).map((c) => ({ ...c, check: c.check ?? value.criteriaChecks[c.id] }));
    const base = this.rules.planVerification({ spec: { ...spec, acceptanceCriteria: checked }, implementation });
    return {
      ...base,
      criteriaChecks: value.criteriaChecks,
      ownTestCriteria: toTest.filter((c) => !value.criteriaChecks[c.id]).map((c) => c.id),
      summary: `${base.summary} Plus ${value.tests} test${value.tests === 1 ? '' : 's'} of its own from your request${value.summary ? `: ${value.summary}` : '.'}`,
      extraFiles: [{ path: QA_AI_TEST_FILE, purpose: 'QA (AI) tests written from the original request and the clarification dialogue', content: value.testFile }],
      commands: [...base.commands, { id: 'ai-tests', kind: 'ai-tests', label: 'Run QA (AI) tests with read-only access', args: ['--test-reporter=tap', QA_AI_TEST_FILE] }],
      concerns: value.concerns,
      requestOnly: value.requestOnly,
      aiCalls,
    };
  }

  /**
   * The verdict: the deterministic checks, and QA's own tests. Criteria QA
   * covered with its own tests pass only if all their tests pass.
   */
  evaluate({ spec, results, plan = {} }) {
    const checks = plan.criteriaChecks ?? {};
    const ownIds = new Set(plan.ownTestCriteria ?? []);
    const checked = spec.acceptanceCriteria.filter((c) => !ownIds.has(c.id)).map((c) => ({ ...c, check: c.check ?? checks[c.id] }));
    const base = this.rules.evaluate({ spec: { ...spec, acceptanceCriteria: checked }, results });
    const requestOnly = new Set(plan.requestOnly ?? []);
    const run = results.commands.find((c) => c.kind === 'ai-tests');
    const tests = run?.tests ?? [];
    const failed = tests.filter((t) => t.status === 'fail');
    // A test file that crashed is QA's own problem, not a product defect.
    const problem = run && (run.timedOut || (!tests.length && run.exitCode !== 0)) ? (run.stderr || run.stdout).trim().slice(0, 1500) || `exit code ${run.exitCode}` : null;
    if (problem && ownIds.size) {
      // Criteria only QA's own tests can verify: the product is not to blame, QA must write its tests again.
      throw new AgentBlockedError(`QA's own tests could not run, and criteria ${[...ownIds].join(', ')} can only be verified by them (${problem.split('\n')[0].slice(0, 200)}). Click Resume: QA writes its tests again.`);
    }
    const aiDefects = failed.map((t) => ({
      title: `${t.name} failed`,
      expected: t.expected ?? null,
      actual: t.actual ?? t.error?.split('\n')[0] ?? null,
      evidence: t.error,
      reportedBy: 'QA (AI test)',
      // A test of something the requirements never stated: the requirements missed it as well.
      origin: requestOnly.has(t.name) ? 'requirements' : 'implementation',
    }));
    const ownResults = new Map(
      [...ownIds].map((id) => {
        const mine = tests.filter((t) => new RegExp(`^QA-AI: ${id}\\b`).test(t.name));
        const status = mine.length && mine.every((t) => t.status === 'pass') ? 'pass' : 'fail';
        const evidence = mine.length ? `${mine.filter((t) => t.status === 'pass').length} of ${mine.length} of QA's own tests for ${id} passed` : `None of QA's own tests for ${id} ran`;
        return [id, { status, evidence, ran: mine.length > 0 }];
      }),
    );
    const missing = [...ownResults].filter(([, r]) => !r.ran).map(([id]) => {
      const c = spec.acceptanceCriteria.find((x) => x.id === id);
      return { criterionId: id, title: `${id} could not be verified: ${c.description}`, expected: `QA's tests for ${id} run`, actual: 'No test result', evidence: 'QA test run', reportedBy: 'QA' };
    });
    const criteria = spec.acceptanceCriteria.map((c) => {
      const own = ownResults.get(c.id);
      return own ? { id: c.id, description: c.description, status: own.status, evidence: own.evidence } : base.criteria.find((r) => r.id === c.id);
    });
    const aiTests = { tests: tests.length, pass: tests.filter((t) => t.status === 'pass').length, fail: failed.length, problem };
    const defects = [...base.defects, ...aiDefects, ...missing];
    const met = criteria.filter((c) => c.status === 'pass').length;
    const verdict = base.verdict === 'pass' && !aiDefects.length && !missing.length && met === criteria.length ? 'pass' : 'fail';
    const ownText = run ? (problem ? 'its own tests could not run' : `${aiTests.pass} of ${aiTests.tests} of its own tests passed`) : 'no tests of its own';
    if (verdict === 'pass') {
      const summary = `Verification passed: ${met} of ${criteria.length} acceptance criteria met; QA (AI): ${ownText}.`;
      return { ...base, verdict, criteria, defects, aiTests, summary, handoffMessage: `${summary} The implementation is ready for your review.` };
    }
    const first = defects[0] ?? { title: 'Not every acceptance criterion was met' };
    return {
      ...base,
      verdict,
      criteria,
      defects,
      aiTests,
      summary: `Verification failed: ${met} of ${criteria.length} acceptance criteria met; ${defects.length} defect(s) (${base.defects.length} from the deterministic checks, ${aiDefects.length} from QA's own tests).`,
      feedbackMessage: `Verification failed with ${defects.length} defect(s). ${first.title}. Please correct the implementation and hand it back for re-testing.`,
    };
  }
}

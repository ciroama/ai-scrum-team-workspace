// Analytics: statistics calculated only from persisted records.
//
// Sources (all already recorded by the workspace):
//  - workflows table: status, verified flag, product, created/finished times
//  - tasks table: agent, stage, status, start/finish times
//  - events: test.results (real test runner counts), handoff (QA -> Developer
//    feedback = correction cycle), workflow.blocked (+ the agent that caused
//    it), workflow.resumed / workflow.cancelled (end of a blocked period)
//
// A project is a product: the first request and its change requests. Every
// task and event belongs to exactly one workflow and every workflow to
// exactly one product, so filtering by workflow id never counts a record
// twice. "All Projects" is simply the union of all workflows.

export const ALL_PROJECTS = 'all';

const SOURCE = { recorded: 'recorded', calculated: 'calculated' };

const durationMs = (from, to) => (from && to ? new Date(to) - new Date(from) : null);
const sum = (values) => values.reduce((a, b) => a + b, 0);
const mean = (values) => (values.length ? sum(values) / values.length : null);
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Validates an optional ISO timestamp filter value. */
export function parseDateFilter(value, name) {
  if (value == null || value === '') return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new Error(`"${name}" must be a date or timestamp`);
  return new Date(time).toISOString();
}

/** The workflows a filter selects: one product (or all), submitted in [from, to). */
export function selectWorkflows(source, { projectId = ALL_PROJECTS, from = null, to = null } = {}) {
  return source.workflows.filter(
    (w) =>
      (projectId === ALL_PROJECTS || (w.productId ?? w.id) === projectId) &&
      (!from || w.createdAt >= from) &&
      (!to || w.createdAt < to),
  );
}

/**
 * @param {{ workflows: object[], tasks: object[], events: object[] }} source  from Repository#analyticsSource
 * @param {{ projectId?: string, from?: string | null, to?: string | null }} filter
 *        from is inclusive, to is exclusive (ISO timestamps, compared with workflow creation time)
 * @param {{ agents: Array<{ id: string, label: string }> }} catalogue
 */
export function computeAnalytics(source, filter = {}, { agents = [] } = {}) {
  const projectId = filter.projectId || ALL_PROJECTS;
  const from = filter.from ?? null;
  const to = filter.to ?? null;
  const projectOf = (workflow) => workflow.productId ?? workflow.id;

  // Project list (always from all workflows, so the selector is stable). The
  // title is the one from the product's latest agreed requirements; a
  // product without any is named after its first request.
  const byProduct = new Map();
  for (const workflow of source.workflows) byProduct.set(projectOf(workflow), [...(byProduct.get(projectOf(workflow)) ?? []), workflow]);
  const projects = [...byProduct.entries()]
    .map(([id, workflows]) => {
      const title = workflows.filter((w) => w.state?.spec).at(-1)?.state.spec.title;
      const first = workflows[0].requestText;
      return { id, title: title ?? `“${first.length > 40 ? `${first.slice(0, 40)}…` : first}”`, workflows: workflows.length };
    })
    .sort((a, b) => a.title.localeCompare(b.title));

  // Selection.
  const selected = selectWorkflows(source, { projectId, from, to });
  const ids = new Set(selected.map((w) => w.id));
  const tasks = source.tasks.filter((t) => ids.has(t.workflowId));
  const events = source.events.filter((e) => ids.has(e.workflowId));

  // Outcomes (recorded statuses).
  const byStatus = (status) => selected.filter((w) => w.status === status);
  const completed = byStatus('completed');
  const verified = completed.filter((w) => w.verified);
  const failed = byStatus('failed');
  const total = selected.length;
  const outcomes = [
    { key: 'verified', label: 'Completed and verified by QA', value: verified.length, tone: 'good' },
    { key: 'completed_unverified', label: 'Completed, not verified', value: completed.length - verified.length, tone: 'neutral' },
    { key: 'blocked', label: 'Blocked (now)', value: byStatus('blocked').length, tone: 'warning' },
    { key: 'needs_clarification', label: 'Needs clarification', value: byStatus('needs_clarification').length, tone: 'neutral' },
    { key: 'running', label: 'Running', value: byStatus('running').length, tone: 'neutral' },
    { key: 'interrupted', label: 'Interrupted', value: byStatus('interrupted').length, tone: 'neutral' },
    { key: 'cancelled', label: 'Cancelled', value: byStatus('cancelled').length, tone: 'neutral' },
    { key: 'failed', label: 'Failed', value: failed.length, tone: 'critical' },
  ];

  // Success rate: verified completions out of workflows that reached a delivery outcome.
  const decided = completed.length + failed.length;

  // Completion time of verified workflows (wall clock, includes blocked time).
  const completionTimes = verified.map((w) => durationMs(w.createdAt, w.finishedAt)).filter((ms) => ms != null && ms >= 0);

  // Tests: every test.results event is one real run of the test runner.
  const testRuns = events.filter((e) => e.type === 'test.results');
  const testSum = (key, runs) => sum(runs.map((e) => e.detail?.summary?.[key] ?? 0));
  const lastRunByWorkflow = new Map();
  for (const run of testRuns) lastRunByWorkflow.set(run.workflowId, run);
  const finalRuns = [...lastRunByWorkflow.values()];

  // Correction cycles: work sent back to the Developer, by QA (defects) or by
  // the PO (rejected although verified).
  // (The PO's requirements handoff to the Developer is not a send-back.)
  const feedback = events.filter((e) => e.type === 'handoff' && e.to === 'dev' && e.status === 'failure' && (e.from === 'qa' || e.from === 'po'));
  const poRework = feedback.filter((e) => e.from === 'po');

  // Blocks caused by disabled agents (older events carry no cause; they were
  // all disabled-agent blocks), and how long any block lasted.
  const allBlocks = events.filter((e) => e.type === 'workflow.blocked');
  const blocks = allBlocks.filter((e) => !e.detail?.cause || e.detail.cause === 'agent_disabled');
  const otherBlocks = allBlocks.filter((e) => e.detail?.cause && e.detail.cause !== 'agent_disabled');
  const aiCalls = events.filter((e) => e.type === 'ai.call');
  // The PO stopping to ask you something: one event per round of questions.
  const poQuestionRounds = events.filter((e) => e.type === 'po.clarification');
  const poQuestions = sum(poQuestionRounds.map((e) => e.detail?.questions?.length || 1));
  const answers = events.filter((e) => e.type === 'clarification.answered');
  const blockedPeriods = allBlocks.map((block) => {
    const end = events.find((e) => e.workflowId === block.workflowId && e.id > block.id && (e.type === 'workflow.resumed' || e.type === 'workflow.cancelled'));
    return { agentId: block.detail?.agentId ?? null, ms: end ? durationMs(block.ts, end.ts) : null };
  });
  const closedPeriods = blockedPeriods.filter((p) => p.ms != null).map((p) => p.ms);

  // Agent activity and execution time (finished tasks only).
  const measurable = (t) => (t.status === 'completed' || t.status === 'failed') && t.finishedAt;
  const interruptedTasks = tasks.filter((t) => t.status === 'interrupted').length;
  const agentRows = agents.map((agent) => {
    const mine = tasks.filter((t) => t.agentId === agent.id);
    const times = mine.filter(measurable).map((t) => durationMs(t.startedAt, t.finishedAt));
    return {
      id: agent.id,
      label: agent.label,
      tasksCompleted: mine.filter((t) => t.status === 'completed').length,
      tasksFailed: mine.filter((t) => t.status === 'failed').length,
      tasksInterrupted: mine.filter((t) => t.status === 'interrupted').length,
      handoffsSent: events.filter((e) => e.type === 'handoff' && e.from === agent.id).length,
      blocksCaused: blocks.filter((b) => b.detail?.agentId === agent.id).length,
      executionMs: times.length ? sum(times) : null,
      averageTaskMs: mean(times),
    };
  });

  const enough = total > 0;
  const kpis = [
    {
      key: 'total',
      group: 'overview',
      label: 'Requests',
      unit: 'count',
      value: enough ? total : null,
      source: SOURCE.recorded,
      basis: 'Workflows table: one row per submitted requirement.',
    },
    {
      key: 'completed',
      group: 'overview',
      label: 'Completed & verified',
      unit: 'count',
      value: enough ? verified.length : null,
      detail: enough && completed.length !== verified.length ? `${completed.length} completed in total` : null,
      source: SOURCE.recorded,
      basis: 'Workflows with status "completed" whose verified flag is set (QA ran its checks and passed, PO accepted).',
    },
    {
      key: 'failed',
      group: 'overview',
      label: 'Failed',
      unit: 'count',
      value: enough ? failed.length : null,
      source: SOURCE.recorded,
      basis: 'Workflows with status "failed" (defects not fixed after 3 attempts, or an execution error).',
    },
    {
      key: 'blocked',
      group: 'flow',
      label: 'Blocked now',
      unit: 'count',
      value: enough ? byStatus('blocked').length : null,
      source: SOURCE.recorded,
      basis: 'Workflows whose current status is "blocked" because a required agent is disabled.',
    },
    {
      key: 'successRate',
      group: 'overview',
      label: 'Success rate',
      unit: 'percent',
      value: decided ? verified.length / decided : null,
      detail: decided ? `${verified.length} of ${decided} delivered workflows` : null,
      source: SOURCE.calculated,
      basis: 'Completed & verified ÷ (completed + failed). Workflows still running, blocked, needing clarification, interrupted or cancelled are not counted as delivered.',
    },
    {
      key: 'completionTime',
      group: 'overview',
      label: 'Average completion time',
      unit: 'duration',
      value: mean(completionTimes),
      detail: completionTimes.length ? `${completionTimes.length} workflow${completionTimes.length === 1 ? '' : 's'} · median ${formatDuration(median(completionTimes))}` : null,
      source: SOURCE.calculated,
      basis: 'Mean of (finished − submitted) for completed & verified workflows. Wall-clock time, including any time spent blocked.',
    },
    {
      key: 'testsPassed',
      group: 'quality',
      label: 'Tests passed',
      unit: 'count',
      value: testRuns.length ? testSum('pass', testRuns) : null,
      detail: testRuns.length ? `across ${testRuns.length} test run${testRuns.length === 1 ? '' : 's'}` : null,
      source: SOURCE.recorded,
      basis: 'Sum of "pass" from every recorded test.results event (one per real node --test run, including re-tests).',
    },
    {
      key: 'testsFailed',
      group: 'quality',
      label: 'Tests failed',
      unit: 'count',
      value: testRuns.length ? testSum('fail', testRuns) : null,
      detail: testRuns.length ? `${testSum('fail', finalRuns)} in each workflow's latest run` : null,
      source: SOURCE.recorded,
      basis: 'Sum of "fail" from every recorded test.results event. The detail line counts only the latest run of each workflow.',
    },
    {
      key: 'corrections',
      group: 'quality',
      label: 'Correction cycles',
      unit: 'count',
      value: testRuns.length ? feedback.length : null,
      detail: testRuns.length ? `in ${new Set(feedback.map((e) => e.workflowId)).size} workflow(s) · ${feedback.length - poRework.length} from QA · ${poRework.length} from the PO` : null,
      source: SOURCE.recorded,
      basis: 'Recorded handoffs that send the work back to the Developer: QA → Developer (failed checks) and PO → Developer (the PO rejected a verified product). Shown once QA has verified at least once.',
    },
    {
      key: 'blocks',
      group: 'flow',
      label: 'Blocks by disabled agents',
      unit: 'count',
      value: enough ? blocks.length : null,
      detail: enough ? agentRows.map((a) => `${a.label} ${a.blocksCaused}`).join(' · ') : null,
      source: SOURCE.recorded,
      basis: 'Recorded workflow.blocked events; each names the disabled agent that caused it.',
    },
    {
      key: 'blockedTime',
      group: 'flow',
      label: 'Average time blocked',
      unit: 'duration',
      value: mean(closedPeriods),
      detail: allBlocks.length ? `${closedPeriods.length} ended · ${blockedPeriods.length - closedPeriods.length} still blocked` : null,
      source: SOURCE.calculated,
      basis: 'Time from each workflow.blocked event (any cause) to the next resume or cancel of that workflow. Blocks that have not ended are not averaged.',
    },
    {
      key: 'otherBlocks',
      group: 'flow',
      label: 'Blocks: AI or configuration',
      unit: 'count',
      value: enough ? otherBlocks.length : null,
      detail: enough && otherBlocks.length ? `${otherBlocks.filter((b) => b.detail.cause === 'ai_unavailable').length} AI service · ${otherBlocks.filter((b) => b.detail.cause !== 'ai_unavailable').length} configuration` : null,
      source: SOURCE.recorded,
      basis: 'Recorded workflow.blocked events caused by the AI service being unavailable (not installed, not logged in, usage limit, timeout, unusable answer) or by a configuration mismatch.',
    },
    {
      key: 'poInterruptions',
      group: 'process',
      label: 'PO interruptions',
      unit: 'count',
      value: enough ? poQuestionRounds.length : null,
      detail: enough
        ? `${poQuestions} question${poQuestions === 1 ? '' : 's'} · in ${new Set(poQuestionRounds.map((e) => e.workflowId)).size} of ${total} requests · ${answers.length} answered`
        : null,
      source: SOURCE.recorded,
      basis: 'Recorded po.clarification events: each time the PO stopped and asked you before writing the requirements, because something was missing, unclear or not buildable. Questions are counted one by one when the PO asked several at once; answers are your recorded clarification.answered events.',
    },
    {
      key: 'aiCalls',
      group: 'overview',
      label: 'AI requests',
      unit: 'count',
      value: enough ? aiCalls.length : null,
      detail: aiCalls.length
        ? `${aiCalls.filter((c) => c.status === 'success').length} succeeded · ${sum(aiCalls.map((c) => (c.detail?.usage?.promptTokens ?? 0) + (c.detail?.usage?.completionTokens ?? 0)))} tokens`
        : null,
      source: SOURCE.recorded,
      basis: 'Recorded ai.call events: every request an AI-powered agent (PO, Developer or QA) sent to Claude Code, with its real outcome and token usage as reported by Claude Code.',
    },
  ];

  // ---- Team process: how each agent worked, compared request by request ----
  const verdicts = events.filter((e) => e.type === 'qa.verdict');
  const failedVerdicts = verdicts.filter((e) => e.status !== 'success');
  const defectsFound = events.filter((e) => e.type === 'defect.reported');
  const fromOwnTests = defectsFound.filter((e) => e.detail?.reportedBy === 'QA (AI test)');
  const concerns = events.filter((e) => e.type === 'qa.concern');
  const reviews = events.filter((e) => e.type === 'po.review');
  const devTasks = tasks.filter((t) => t.agentId === 'dev' && t.status === 'completed' && (t.stage === 'implementation' || t.stage === 'correction'));
  const poDecided = sum(events.filter((e) => e.type === 'po.requirements').map((e) => (e.detail?.assumptions ?? []).filter((a) => a.decidedBy === 'po').length));
  const verifiedWorkflows = [...new Set(verdicts.map((e) => e.workflowId))];
  const firstTimeRight = verifiedWorkflows.filter((id) => {
    const first = verdicts.find((e) => e.workflowId === id);
    return first.status === 'success' && !poRework.some((e) => e.workflowId === id);
  });
  const askedIn = new Set(poQuestionRounds.map((e) => e.workflowId)).size;
  // Where problems came from: the requirements (PO) or the code (Developer).
  const reworkOrigins = poRework.flatMap((e) => e.detail?.origins ?? []);
  const fromRequirements = defectsFound.filter((e) => e.detail?.origin === 'requirements').length + reworkOrigins.filter((o) => o === 'requirements').length;
  const fromCode = defectsFound.filter((e) => e.detail?.origin !== 'requirements').length + reworkOrigins.filter((o) => o === 'implementation').length;
  // AI answers an agent's contract refused (the agent had to answer again).
  const refused = (agentId) => aiCalls.filter((e) => e.actor === agentId && e.status !== 'success' && /^Answer rejected/.test(e.detail?.error ?? '')).length;
  const guessesStopped = aiCalls.filter((e) => e.actor === 'po' && /ask instead of deciding|whyNoQuestions/.test(e.detail?.error ?? '')).length;
  const concernAnswers = reviews.flatMap((e) => e.detail?.concernResponses ?? []);
  const refusedBasis = (who) => `AI requests of the ${who} whose answer broke its contract and was sent back (recorded ai.call events "Answer rejected"); the ${who} then had to answer again.`;
  const metric = (key, label, value, detail, source, basis, unit = 'count') => ({ key, label, unit, value: enough ? value : null, detail: enough ? detail : null, source, basis });
  const process = {
    po: [
      metric('poInterruptionsCount', 'Times it stopped to ask you', poQuestionRounds.length, `in ${askedIn} of ${total} request${total === 1 ? '' : 's'}`, SOURCE.recorded, 'Recorded po.clarification events: each one is the PO stopping the work to ask you before writing the requirements.'),
      metric('poQuestionsCount', 'Questions asked', poQuestions, poQuestionRounds.length ? `${(poQuestions / poQuestionRounds.length).toFixed(1)} per interruption` : null, SOURCE.recorded, 'Every question counts, also when the PO asked several in one message (the questions recorded on each po.clarification event).'),
      metric('poAnswers', 'Answers it needed from you', answers.length, null, SOURCE.recorded, 'Recorded clarification.answered events.'),
      metric('poDecided', 'Details you left to the PO', poDecided, null, SOURCE.recorded, 'Assumptions marked "decided by the PO" in the agreed requirements, after you told the PO to decide.'),
      metric('poGuessesStopped', 'Guesses stopped', guessesStopped, 'it decided something you never said and had to ask instead', SOURCE.recorded, 'PO answers refused because, before you had answered anything, they decided a detail you never gave (or skipped the questions without a reason). The PO then had to ask.'),
      metric('poRequirementGaps', 'Requirement gaps found later', fromRequirements, 'by QA\'s own tests or by the PO\'s review', SOURCE.recorded, 'Problems whose origin is the requirements: failing QA tests of things you asked that the requirements never stated, and PO rejection reasons marked "requirements".'),
      metric('poConcerns', 'QA concerns it agreed with', concernAnswers.filter((r) => r.decision === 'agree').length, concernAnswers.length ? `of ${concernAnswers.length} answered · ${concernAnswers.filter((r) => r.decision === 'disagree').length} dismissed` : null, SOURCE.recorded, 'The PO\'s explicit answer to each concern QA raised, recorded with its final review.'),
      metric('poRejected', 'Verified work it sent back', poRework.length, `${reviews.filter((e) => e.status === 'success').length} accepted`, SOURCE.recorded, 'PO → Developer rework handoffs: the PO rejected a product that QA had verified, and said why.'),
      metric('poRefused', 'AI answers refused by its rules', refused('po'), null, SOURCE.recorded, refusedBasis('PO')),
    ],
    dev: [
      metric('devDeliveries', 'Implementations delivered', devTasks.length, 'first builds and corrections', SOURCE.recorded, 'Completed Developer tasks in the implementation and correction stages.'),
      metric('devCaughtByQa', 'Caught by QA', failedVerdicts.length, devTasks.length ? `${failedVerdicts.length} of ${devTasks.length} deliveries failed verification` : null, SOURCE.recorded, 'Recorded qa.verdict events with a failing verdict: each one is a delivery in which QA found at least one defect.'),
      metric('devSentBackByPo', 'Sent back by the PO', poRework.length, null, SOURCE.recorded, 'PO → Developer rework handoffs after QA had verified the delivery.'),
      metric('devCodeDefects', 'Code defects found', fromCode, 'by QA or by the PO\'s review', SOURCE.recorded, 'Problems whose origin is the implementation: failed acceptance checks, failing QA tests of things the requirements state, and PO rejection reasons marked "implementation".'),
      metric('devRefused', 'AI answers refused by its rules', refused('dev'), null, SOURCE.recorded, refusedBasis('Developer')),
      metric('devFirstTimeRight', 'Right first time', verifiedWorkflows.length ? firstTimeRight.length / verifiedWorkflows.length : null, verifiedWorkflows.length ? `${firstTimeRight.length} of ${verifiedWorkflows.length} requests` : null, SOURCE.calculated, 'Requests whose first delivery passed QA and was not sent back by the PO, out of the requests QA verified at least once.', 'percent'),
    ],
    qa: [
      metric('qaVerifications', 'Verifications run', verdicts.length, null, SOURCE.recorded, 'Recorded qa.verdict events: one per verification of a delivery.'),
      metric('qaDefects', 'Defects found', defectsFound.length, `${defectsFound.length - fromOwnTests.length} by the acceptance checks · ${fromOwnTests.length} by its own tests · ${defectsFound.filter((e) => e.detail?.origin === 'requirements').length} in the requirements`, SOURCE.recorded, 'Recorded defect.reported events. "Its own tests" are the tests an AI-powered QA wrote from your request.'),
      metric('qaConcerns', 'Requirement concerns raised', concerns.length, null, SOURCE.recorded, 'Recorded qa.concern events: the requirements may not match your request (AI-powered QA only).'),
      metric('qaMissed', 'Passed by QA, rejected by the PO', poRework.length, null, SOURCE.recorded, 'Deliveries QA verified that the PO then rejected: problems the tests did not catch, according to the PO.'),
      metric('qaRefused', 'AI answers refused by its rules', refused('qa'), null, SOURCE.recorded, refusedBasis('QA')),
    ],
  };

  // ---- Compare models: requests grouped by the models the agents really used ----
  const modelComparison = compareModels(selected, tasks, events);

  return {
    filter: { projectId, from, to },
    process,
    modelComparison,
    projects,
    empty: !enough,
    kpis,
    outcomes,
    agents: agentRows,
    workflows: selected.map((w) => ({ id: w.id, createdAt: w.createdAt, status: w.status, verified: w.verified, projectId: projectOf(w) })),
    notes: [
      'A project is a product: its first request and all its change requests. A product without agreed requirements is named after its first request.',
      'Date filters use the time each workflow was submitted.',
      `Agent execution times use finished tasks only${interruptedTasks ? `; ${interruptedTasks} task(s) cut off by a shutdown are excluded` : ''}.`,
      'Tasks run back to back, so measured execution times are short; they are the real durations recorded for each task.',
    ],
    notAvailable: [
      'Waiting time between handoffs: the next agent starts as soon as it receives a handoff, so the only waiting the workspace records is time spent blocked by a disabled agent (shown above).',
      'Agent idle time and time spent by you reviewing results: not recorded.',
      'Workflows from Milestone 1 (kept in data/workspace.v1.db) are not included.',
    ],
  };
}

/** "claude-sonnet-5-5" -> "sonnet 5.5"; other names are kept as they are. */
export function shortModel(model) {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(model ?? '');
  return m ? `${m[1]} ${m[2]}.${m[3]}` : model;
}

/**
 * The setup a request really ran with: for each agent, the model(s) its
 * recorded AI requests used, "scripted" if it worked without AI, or "—".
 */
export function setupOf(workflowId, tasks, events) {
  const setup = {};
  for (const agentId of ['po', 'dev', 'qa']) {
    const models = [...new Set(events.filter((e) => e.type === 'ai.call' && e.workflowId === workflowId && e.actor === agentId && e.detail?.model).map((e) => shortModel(e.detail.model)))];
    const worked = tasks.some((t) => t.workflowId === workflowId && t.agentId === agentId);
    setup[agentId] = models.length ? models.join(' + ') : worked ? 'scripted' : '—';
  }
  return setup;
}

/** Process numbers per team setup, so different models can be compared on the same kind of work. */
function compareModels(workflows, tasks, events) {
  const groups = new Map();
  for (const w of workflows) {
    const setup = setupOf(w.id, tasks, events);
    const key = `PO: ${setup.po} · Developer: ${setup.dev} · QA: ${setup.qa}`;
    if (!groups.has(key)) groups.set(key, { key, setup, workflows: [] });
    groups.get(key).workflows.push(w);
  }
  return [...groups.values()].map(({ key, setup, workflows: list }) => {
    const ids = new Set(list.map((w) => w.id));
    const of = (type) => events.filter((e) => e.type === type && ids.has(e.workflowId));
    const n = list.length;
    const verdicts = of('qa.verdict');
    const verifiedOnce = [...new Set(verdicts.map((e) => e.workflowId))];
    const rework = of('handoff').filter((e) => e.from === 'po' && e.to === 'dev' && e.status === 'failure');
    const firstTimeRight = verifiedOnce.filter((id) => verdicts.find((e) => e.workflowId === id).status === 'success' && !rework.some((e) => e.workflowId === id));
    const calls = of('ai.call');
    const delivered = list.filter((w) => w.status === 'completed' || w.status === 'failed');
    const verified = list.filter((w) => w.status === 'completed' && w.verified);
    const times = verified.map((w) => durationMs(w.createdAt, w.finishedAt)).filter((ms) => ms != null && ms >= 0);
    const per = (value) => (n ? value / n : null);
    return {
      setup: key,
      models: setup,
      requests: n,
      verifiedRate: delivered.length ? verified.length / delivered.length : null,
      poQuestionsPerRequest: per(sum(of('po.clarification').map((e) => e.detail?.questions?.length || 1))),
      defectsPerRequest: per(of('defect.reported').length),
      reworkPerRequest: per(rework.length),
      firstTimeRight: verifiedOnce.length ? firstTimeRight.length / verifiedOnce.length : null,
      aiRequestsPerRequest: per(calls.length),
      tokensPerRequest: per(sum(calls.map((c) => (c.detail?.usage?.promptTokens ?? 0) + (c.detail?.usage?.completionTokens ?? 0)))),
      averageCompletionMs: mean(times),
    };
  });
}

function formatDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
}

import { STAGES, UPCOMING_AGENTS } from './stages.js';

/**
 * Builds the dashboard view of each agent from recorded state.
 *
 * Availability (enabled/disabled) is configuration. Execution status
 * (idle/working/waiting/completed/failed) is derived from tasks: an agent
 * is "working" only while it has a task with status 'running'.
 *
 * @param {object} input
 * @param {Map<string, import('../agents/agent.js').Agent>} input.team
 * @param {Record<string, { enabled: boolean, updatedAt: string }>} input.config
 * @param {object | null} input.workflow  the workflow shown on the dashboard
 * @param {object[]} input.tasks          tasks of that workflow
 * @param {object[]} input.events         timeline of that workflow
 */
export function describeTeam({ team, config, workflow, tasks, events }) {
  const labelOf = (id) => (id === 'user' ? 'You' : team.get(id)?.label ?? 'System');

  return [...team.values()].map((agent) => {
    const enabled = config[agent.id]?.enabled ?? false;
    const mine = tasks.filter((t) => t.agentId === agent.id);
    const running = mine.find((t) => t.status === 'running');
    const lastFinished = [...mine].reverse().find((t) => t.status !== 'running');

    let execution = 'idle';
    let activity = enabled ? 'Available for new assignments' : 'Not available for new assignments';

    if (running) {
      execution = 'working';
      activity = running.title;
    } else if (workflow?.status === 'running' || workflow?.status === 'blocked') {
      const stage = STAGES[workflow.stage];
      if (workflow.status === 'blocked' && stage.agent === agent.id) {
        activity = enabled
          ? `Needed to continue: ${workflow.blockedReason ?? `${stage.title} is blocked`}`
          : `Needed to continue: ${stage.title} is blocked until ${agent.label} is enabled`;
      } else if (!enabled) {
        activity = UPCOMING_AGENTS[workflow.stage].includes(agent.id)
          ? `Disabled: the workflow will block if ${agent.label} is still disabled when needed`
          : activity;
      } else if (workflow.status === 'blocked') {
        execution = 'waiting';
        activity = `Waiting: the workflow is blocked at ${stage.title}`;
      } else if (UPCOMING_AGENTS[workflow.stage].includes(agent.id)) {
        execution = 'waiting';
        activity = `Waiting for ${labelOf(stage.agent)} to finish ${stage.title.toLowerCase()}`;
      } else if (lastFinished) {
        execution = lastFinished.status === 'completed' ? 'completed' : 'failed';
        activity = `Finished: ${lastFinished.title.toLowerCase()}`;
      }
    } else if (workflow && lastFinished) {
      execution = lastFinished.status === 'completed' ? 'completed' : 'failed';
      activity = `Last task: ${lastFinished.title.toLowerCase()}`;
    }

    const handoff = [...events].reverse().find((e) => e.type === 'handoff' && (e.from === agent.id || e.to === agent.id));
    const configChange = [...events].reverse().find((e) => e.category === 'config' && e.detail?.agentId === agent.id);

    return {
      ...agent.profile,
      enabled,
      mode: config[agent.id]?.mode ?? 'scripted',
      model: config[agent.id]?.model ?? null,
      supportsAi: Boolean(team.supportsAi?.(agent.id)),
      configUpdatedAt: config[agent.id]?.updatedAt ?? null,
      finishingTask: !enabled && running ? running.title : null,
      execution,
      activity,
      lastOutcome: lastFinished
        ? { status: lastFinished.status, summary: lastFinished.output?.summary ?? lastFinished.error ?? lastFinished.title, at: lastFinished.finishedAt }
        : null,
      lastHandoff: handoff
        ? { from: labelOf(handoff.from), to: labelOf(handoff.to), summary: handoff.summary, at: handoff.ts }
        : null,
      lastConfigChange: configChange ? { summary: configChange.summary, at: configChange.ts } : null,
    };
  });
}

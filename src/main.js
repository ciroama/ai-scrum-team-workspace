// Entry point. Checks the Node.js version before loading anything that
// depends on node:sqlite (built in and unflagged from Node 22.13).

const REQUIRED = { major: 22, minor: 13 };

const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== REQUIRED.major || minor < REQUIRED.minor) {
  console.error(
    `AI Scrum Team Workspace needs Node.js ${REQUIRED.major}.x (>= ${REQUIRED.major}.${REQUIRED.minor}).\n` +
      `You are running Node.js ${process.versions.node}.\n` +
      'Install the Node.js 22 LTS macOS installer (.pkg) from https://nodejs.org/dist/latest-v22.x/',
  );
  process.exit(1);
}

const { startServer } = await import('./server/app.js');

const port = Number(process.env.PORT ?? 3000);
const dataDir = process.env.WORKSPACE_DATA_DIR ?? 'data';
// A fixed port, so an SSH tunnel can forward it when the workspace runs in a
// virtual machine. PREVIEW_PORT=0 picks a free port instead.
const previewPort = Number(process.env.PREVIEW_PORT ?? 3001);
// Advanced: the Claude Code command, if it is not on the PATH as "claude".
const claudeBinary = process.env.CLAUDE_BINARY || undefined;

let app;
try {
  app = await startServer({ port, dataDir, previewPort, claudeBinary });
} catch (error) {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Stop the other program or start with another port, e.g.: PORT=4000 npm start`);
  } else {
    console.error(`The workspace could not start: ${error.message}`);
    console.error(`Check that the data folder "${dataDir}" is writable.`);
  }
  process.exit(1);
}

console.log(`AI Scrum Team Workspace running at ${app.url}`);
console.log(`Live Preview port: ${previewPort || 'chosen automatically'}`);
console.log(`Data folder: ${dataDir} (SQLite database + generated products)`);
if (app.legacyBackup) console.log(`The Milestone 1 database was kept as ${app.legacyBackup}.`);
const modes = app.repository.getAgentConfig();
const aiAgents = ['po', 'dev'].filter((id) => modes[id]?.mode === 'ai');
console.log(
  aiAgents.length
    ? `AI-powered agents: ${aiAgents.map((id) => (id === 'po' ? 'PO' : 'Developer')).join(', ')} (Claude Code, model ${app.aiSettings.model}). QA is scripted.`
    : 'The PO, Developer and QA agents are scripted (rules and templates, no AI model). AI can be enabled on the Team page.',
);
console.log('Keep this window open while you use the dashboard. Press Ctrl+C to stop.');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

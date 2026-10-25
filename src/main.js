// Entry point. Checks the Node.js version before loading anything that
// depends on node:sqlite (built in and unflagged from Node 22.13).

const REQUIRED = { major: 22, minor: 13 };

const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== REQUIRED.major || minor < REQUIRED.minor) {
  console.error(
    `AI Scrum Team Workspace needs Node.js ${REQUIRED.major}.x (>= ${REQUIRED.major}.${REQUIRED.minor}).\n` +
      `You are running Node.js ${process.versions.node}.\n` +
      'Install the Node.js 22 LTS macOS installer (.pkg) from https://nodejs.org/en/download',
  );
  process.exit(1);
}

const { startServer } = await import('./server/app.js');

const port = Number(process.env.PORT ?? 3000);
const dataDir = process.env.WORKSPACE_DATA_DIR ?? 'data';

const { url, close } = await startServer({ port, dataDir });
console.log(`AI Scrum Team Workspace running at ${url}`);
console.log(`Data directory: ${dataDir} (SQLite database + generated run workspaces)`);
console.log('Agents in this milestone are SCRIPTED (rule/template based). No AI model or paid API is used.');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await close();
    process.exit(0);
  });
}

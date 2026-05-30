const { registerSlashCommands } = require('../commands/slashCommands');

async function handleClientReady(client, token) {
  console.log(`Logged in as ${client.user.tag}`);

  await registerSlashCommands(client.user.id, token).catch((err) => {
    console.error('Failed to register slash commands:', err.message);
  });
}

module.exports = { handleClientReady };

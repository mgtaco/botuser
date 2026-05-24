const { RESPONSE_CHANNEL_IDS } = require('../config');
const { registerSlashCommands } = require('../commands/slashCommands');
const { validateChannelIds } = require('./channels');

async function handleClientReady(client, token, responseChannelIds = RESPONSE_CHANNEL_IDS) {
  console.log(`Logged in as ${client.user.tag}`);
  await validateChannelIds(client, responseChannelIds, 'Response');

  await registerSlashCommands(client.user.id, token).catch((err) => {
    console.error('Failed to register slash command:', err.message);
  });
}

module.exports = { handleClientReady };

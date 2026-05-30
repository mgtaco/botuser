require('dotenv').config();

const { Events } = require('discord.js');
const { PORT } = require('./lib/config');
const { startHealthServer } = require('./lib/health');
const { createDiscordClient } = require('./lib/discord/client');
const { handleClearInteraction } = require('./lib/commands/clear');
const { handleConfigInteraction } = require('./lib/commands/config');
const { handleClientReady } = require('./lib/discord/readyHandler');
const { handleMessageCreate } = require('./lib/discord/messageHandler');

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('DISCORD_TOKEN is not set. Copy .env.example to .env and add your token.');
  process.exit(1);
}

startHealthServer(PORT);

const client = createDiscordClient();

client.once(Events.ClientReady, (readyClient) => {
  handleClientReady(readyClient, token).catch((err) => {
    console.error('Ready handler error:', err.message);
  });
});

client.on(Events.MessageCreate, (message) => {
  handleMessageCreate(message).catch((err) => {
    console.error('Message handler error:', err.message);
  });
});

client.on(Events.InteractionCreate, (interaction) => {
  Promise.all([
    handleClearInteraction(interaction),
    handleConfigInteraction(interaction),
  ]).catch((err) => {
    console.error('Interaction handler error:', err.message);
  });
});

client.login(token).catch((err) => {
  console.error('Login failed:', err.message);
  process.exit(1);
});

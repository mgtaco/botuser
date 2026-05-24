const { Client, IntentsBitField } = require('discord.js');

function createDiscordClient() {
  return new Client({
    intents: [
      IntentsBitField.Flags.Guilds,
      IntentsBitField.Flags.GuildMembers,
      IntentsBitField.Flags.GuildMessages,
      IntentsBitField.Flags.GuildVoiceStates,
      IntentsBitField.Flags.MessageContent,
    ],
  });
}

module.exports = { createDiscordClient };

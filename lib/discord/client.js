const { Client, IntentsBitField, Partials } = require('discord.js');

function createDiscordClient() {
  return new Client({
    intents: [
      IntentsBitField.Flags.Guilds,
      IntentsBitField.Flags.GuildMembers,
      IntentsBitField.Flags.GuildMessages,
      IntentsBitField.Flags.GuildVoiceStates,
      IntentsBitField.Flags.MessageContent,
      IntentsBitField.Flags.DirectMessages,
    ],
    // DM channels and messages arrive uncached, so we must opt in to
    // partial structures to receive MessageCreate events in DMs.
    partials: [Partials.Channel, Partials.Message],
  });
}

module.exports = { createDiscordClient };

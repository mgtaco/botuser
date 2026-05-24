const { REST, Routes } = require('discord.js');
const { createClearCommand } = require('./clear');

function buildSlashCommands() {
  return [
    createClearCommand(),
  ];
}

async function registerSlashCommands(clientId, token) {
  const rest = new REST({ version: '10' }).setToken(token);

  await rest.put(Routes.applicationCommands(clientId), {
    body: buildSlashCommands().map((command) => command.toJSON()),
  });
}

module.exports = {
  buildSlashCommands,
  registerSlashCommands,
};

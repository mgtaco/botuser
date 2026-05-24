const { PermissionsBitField, SlashCommandBuilder } = require('discord.js');

const CLEAR_COMMAND_NAME = 'clear';

function createClearCommand() {
  return new SlashCommandBuilder()
    .setName(CLEAR_COMMAND_NAME)
    .setDescription('Clear recent messages in this channel')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages);
}

async function handleClearInteraction(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== CLEAR_COMMAND_NAME) return;

  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const channel = interaction.channel;

  const sendClearResponse = async (content) => {
    await interaction.editReply(content).catch(() => {});
  };

  if (typeof channel?.bulkDelete !== 'function') {
    await sendClearResponse("Can't clear messages in this channel.");
    return;
  }

  try {
    const deleted = await channel.bulkDelete(100, true);
    await sendClearResponse(`Cleared ${deleted.size} message(s).`);
  } catch (err) {
    console.error('Clear error:', err.message);
    await sendClearResponse(`Failed: ${err.message}`);
  }
}

module.exports = {
  CLEAR_COMMAND_NAME,
  createClearCommand,
  handleClearInteraction,
};

const {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  SlashCommandBuilder,
  MessageFlags,
} = require('discord.js');
const {
  KNOWLEDGE_TAG,
  REPLY_TAG,
  applyTag,
  findKnowledgeChannel,
  getReplyChannelIds,
  hasTag,
} = require('../discord/channelConfig');

const CONFIG_COMMAND_NAME = 'config';

function createConfigCommand() {
  return new SlashCommandBuilder()
    .setName(CONFIG_COMMAND_NAME)
    .setDescription('Configure the AI bot (admins only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName('knowledge-channel')
        .setDescription('Set the channel the bot reads knowledge from')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Channel containing knowledge messages')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('reply-add')
        .setDescription('Allow the bot to reply in a channel')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Channel to allow replies in')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('reply-remove')
        .setDescription('Stop the bot from replying in a channel')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Channel to remove from the reply list')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('reply-clear')
        .setDescription('Clear the reply list (bot replies in all channels)')
    )
    .addSubcommand((sub) =>
      sub.setName('show').setDescription('Show the current bot configuration')
    );
}

function formatConfig(guild) {
  const knowledge = findKnowledgeChannel(guild);
  const replyIds = getReplyChannelIds(guild);

  const knowledgeLine = knowledge ? `<#${knowledge.id}>` : '_not set_';
  const replyLine = replyIds.size
    ? [...replyIds].map((id) => `<#${id}>`).join(', ')
    : '_all channels_';

  return `**Knowledge channel:** ${knowledgeLine}\n**Reply channels:** ${replyLine}`;
}

async function reply(interaction, content) {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
}

// Edits a channel's topic to add or remove one of the AI tags.
async function setChannelTag(channel, tag, enabled) {
  const next = applyTag(channel.topic, tag, enabled);
  if (next === (channel.topic ?? '')) return;
  await channel.setTopic(next, `AI bot config: ${enabled ? 'add' : 'remove'} ${tag}`);
}

function botCanManage(guild, channel) {
  const me = guild.members.me;
  return Boolean(
    me?.permissions.has(PermissionsBitField.Flags.ManageChannels) &&
      channel.permissionsFor(me)?.has(PermissionsBitField.Flags.ManageChannels)
  );
}

async function handleConfigInteraction(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== CONFIG_COMMAND_NAME) return;

  if (!interaction.guild) {
    return reply(interaction, 'This command can only be used in a server.');
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return reply(interaction, 'You need the Administrator permission to use this command.');
  }

  const guild = interaction.guild;
  const sub = interaction.options.getSubcommand();

  if (sub === 'show') {
    return reply(interaction, formatConfig(guild));
  }

  const channel = interaction.options.getChannel('channel');

  if (channel && !botCanManage(guild, channel)) {
    return reply(
      interaction,
      `⚠️ I need the **Manage Channels** permission on <#${channel.id}> to edit its topic tag.`
    );
  }

  try {
    switch (sub) {
      case 'knowledge-channel': {
        // Only one knowledge channel: clear the tag from any previous one first.
        const previous = findKnowledgeChannel(guild);
        if (previous && previous.id !== channel.id && botCanManage(guild, previous)) {
          await setChannelTag(previous, KNOWLEDGE_TAG, false);
        }
        await setChannelTag(channel, KNOWLEDGE_TAG, true);
        return reply(
          interaction,
          `✅ Knowledge channel set to <#${channel.id}>.\n\n${formatConfig(guild)}`
        );
      }
      case 'reply-add': {
        await setChannelTag(channel, REPLY_TAG, true);
        return reply(
          interaction,
          `✅ The bot will now reply in <#${channel.id}>.\n\n${formatConfig(guild)}`
        );
      }
      case 'reply-remove': {
        await setChannelTag(channel, REPLY_TAG, false);
        return reply(
          interaction,
          `✅ Removed <#${channel.id}> from the reply list.\n\n${formatConfig(guild)}`
        );
      }
      case 'reply-clear': {
        const tagged = guild.channels.cache.filter(
          (ch) => ch.type === ChannelType.GuildText && hasTag(ch.topic, REPLY_TAG)
        );
        for (const ch of tagged.values()) {
          if (botCanManage(guild, ch)) await setChannelTag(ch, REPLY_TAG, false);
        }
        return reply(
          interaction,
          `✅ Reply list cleared — the bot replies in all channels.\n\n${formatConfig(guild)}`
        );
      }
      default:
        return reply(interaction, 'Unknown subcommand.');
    }
  } catch (err) {
    console.error('[config] error:', err.message);
    return reply(interaction, `⚠️ Could not update config: ${err.message}`);
  }
}

module.exports = {
  CONFIG_COMMAND_NAME,
  createConfigCommand,
  handleConfigInteraction,
};

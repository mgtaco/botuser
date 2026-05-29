const { RESPONSE_CHANNEL_IDS } = require('../config');
const { shouldRespondAndReply } = require('../groq');
const { buildKnowledgeContext } = require('../knowledge');
const { buildConversationMessages, getBotDisplayName } = require('./conversation');
const { sendReply } = require('./replies');

async function handleMessageCreate(message, responseChannelIds = RESPONSE_CHANNEL_IDS) {
  if (message.author.bot) return;

  // Always respond in DMs. The channel allowlist only restricts guild channels.
  const isDM = !message.guildId;
  if (!isDM && responseChannelIds.size && !responseChannelIds.has(message.channelId)) return;

  console.log(
    `\n[Discord] ${message.author.tag} in ${message.guild?.name ?? 'DM'}/${message.channel?.name ?? message.channelId}: ${message.content || '(no text)'}`
  );

  const botName = getBotDisplayName(message);
  const turns = await buildConversationMessages(
    message.channel,
    message.client.user.id,
    botName
  );
  const knowledgeContext = await buildKnowledgeContext(message.guildId, message.content ?? '');

  const { reply } = await shouldRespondAndReply({
    messages: turns,
    botName,
    knowledgeContext,
  });

  if (!reply?.trim()) return;

  try {
    await sendReply(message.channel, reply);
  } catch (err) {
    console.error('Failed to send reply:', err.message);
  }
}

module.exports = { handleMessageCreate };

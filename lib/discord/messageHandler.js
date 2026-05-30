const { shouldRespondAndReply } = require('../groq');
const { buildKnowledgeContext } = require('../knowledge');
const { shouldReplyInChannel } = require('./channelConfig');
const { buildConversationMessages, getBotDisplayName } = require('./conversation');
const { sendReply } = require('./replies');

async function handleMessageCreate(message) {
  if (message.author.bot) return;
  // Reply rules come from channel topic tags (and DMs are always allowed).
  if (!shouldReplyInChannel(message)) return;

  console.log(
    `\n[Discord] ${message.author.tag} in ${message.guild?.name ?? 'DM'}/${message.channel?.name ?? message.channelId}: ${message.content || '(no text)'}`
  );

  const botName = getBotDisplayName(message);
  const turns = await buildConversationMessages(
    message.channel,
    message.client.user.id,
    botName
  );
  const knowledgeContext = await buildKnowledgeContext(message.guild, message.content ?? '');

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

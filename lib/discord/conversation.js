const { RECENT_MESSAGES_LIMIT } = require('../config');

function formatUserMessage(msg, botId, botName) {
  const name = msg.author?.username ?? 'Unknown';
  const content = (msg.content?.trim() || '(no text)')
    .replace(new RegExp(`<@!?${botId}>`, 'g'), `@${botName}`);
  return `${name}: ${content}`;
}

function formatAssistantMessage(msg) {
  return msg.content?.trim() || '(no text)';
}

function getBotDisplayName(message) {
  return message.guild?.members.me?.displayName ?? message.client.user.username;
}

async function buildConversationMessages(channel, botId, botName) {
  const messages = await channel.messages.fetch({ limit: RECENT_MESSAGES_LIMIT });

  const sorted = [...messages.values()].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );

  return sorted.map((msg) => {
    const isBotMessage = msg.author.id === botId;

    return {
      role: isBotMessage ? 'assistant' : 'user',
      content: isBotMessage
        ? formatAssistantMessage(msg)
        : formatUserMessage(msg, botId, botName),
    };
  });
}

module.exports = {
  buildConversationMessages,
  formatAssistantMessage,
  formatUserMessage,
  getBotDisplayName,
};

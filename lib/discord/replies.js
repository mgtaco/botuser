const { DISCORD_MESSAGE_LIMIT } = require('../config');

function splitDiscordMessage(content) {
  const chunks = [];
  let remaining = content;

  while (remaining.length > DISCORD_MESSAGE_LIMIT) {
    let splitAt = remaining.lastIndexOf('\n', DISCORD_MESSAGE_LIMIT);

    if (splitAt < DISCORD_MESSAGE_LIMIT / 2) {
      splitAt = remaining.lastIndexOf(' ', DISCORD_MESSAGE_LIMIT);
    }

    if (splitAt < 1) {
      splitAt = DISCORD_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function isImagePreviewUrl(url) {
  return /\.(png|jpe?g|gif|webp|avif)(?:[/?#]|$)/i.test(url);
}

function hasImagePreviewLink(content) {
  const linkPattern = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>)]+)/g;
  let match;

  while ((match = linkPattern.exec(content)) !== null) {
    const url = match[2] ?? match[3];
    if (isImagePreviewUrl(url)) return true;
  }

  return false;
}

function splitReplyAfterImageLinkLines(content) {
  const messages = [];
  const pending = [];

  const flushPending = () => {
    const text = pending.join('\n').trim();
    pending.length = 0;
    if (text) messages.push(text);
  };

  for (const line of content.split('\n')) {
    pending.push(line);

    if (hasImagePreviewLink(line)) {
      flushPending();
    }
  }

  flushPending();
  return messages.length ? messages : [content];
}

async function sendReply(channel, reply) {
  for (const message of splitReplyAfterImageLinkLines(reply)) {
    for (const chunk of splitDiscordMessage(message)) {
      await channel.send(chunk);
    }
  }
}

module.exports = {
  hasImagePreviewLink,
  sendReply,
  splitDiscordMessage,
  splitReplyAfterImageLinkLines,
};

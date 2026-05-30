const { ChannelType } = require('discord.js');

// Per-guild configuration is stored entirely inside Discord, as tags in each
// channel's topic/description. This means the bot needs no database, no extra
// env vars, and the config survives restarts and redeploys on ephemeral hosts
// like Koyeb (Discord itself is the source of truth).
//
//   [ai-knowledge]  -> the channel the bot reads knowledge from (one per guild)
//   [ai-reply]      -> a channel the bot is allowed to reply in
//
// If no channel is tagged [ai-reply], the bot replies in every channel (minus
// the knowledge channel). DMs are always allowed and are unaffected by tags.

const KNOWLEDGE_TAG = '[ai-knowledge]';
const REPLY_TAG = '[ai-reply]';

function hasTag(topic, tag) {
  return typeof topic === 'string' && topic.toLowerCase().includes(tag);
}

// Adds or removes a tag from a topic string, preserving any other text the
// channel topic already contains.
function applyTag(topic, tag, enabled) {
  const base = (topic ?? '').replace(new RegExp(`\\s*${escapeRegExp(tag)}`, 'gi'), '').trim();
  if (!enabled) return base;
  return base ? `${base} ${tag}` : tag;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isTextChannel(channel) {
  return channel?.type === ChannelType.GuildText;
}

// Returns the first text channel tagged as the knowledge source, or null.
function findKnowledgeChannel(guild) {
  return (
    guild?.channels.cache.find(
      (channel) => isTextChannel(channel) && hasTag(channel.topic, KNOWLEDGE_TAG)
    ) ?? null
  );
}

// Returns the set of channel IDs the bot is allowed to reply in. An empty set
// means "reply everywhere".
function getReplyChannelIds(guild) {
  const ids = new Set();
  if (!guild) return ids;

  for (const channel of guild.channels.cache.values()) {
    if (isTextChannel(channel) && hasTag(channel.topic, REPLY_TAG)) {
      ids.add(channel.id);
    }
  }

  return ids;
}

// Decides whether the bot should reply to a message based on the channel tags.
// DMs always pass; the knowledge channel never gets replies.
function shouldReplyInChannel(message) {
  if (!message.guild) return true; // DMs

  if (hasTag(message.channel?.topic, KNOWLEDGE_TAG)) return false;

  const replyIds = getReplyChannelIds(message.guild);
  if (!replyIds.size) return true; // none configured -> reply everywhere

  return replyIds.has(message.channelId);
}

module.exports = {
  KNOWLEDGE_TAG,
  REPLY_TAG,
  applyTag,
  findKnowledgeChannel,
  getReplyChannelIds,
  hasTag,
  shouldReplyInChannel,
};

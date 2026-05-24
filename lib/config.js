const path = require('path');

function parseChannelIds(raw) {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

const PORT = Number(process.env.PORT) || 8000;
const RECENT_MESSAGES_LIMIT = 8;
const DISCORD_MESSAGE_LIMIT = 2000;
const RESPONSE_CHANNEL_IDS = parseChannelIds(
  process.env.RESPONSE_CHANNEL_IDS ?? process.env.RESPONSE_CHANNEL_ID
);

const KNOWLEDGE = {
  contextCharLimit: 5000,
  maxChunks: 8,
  cacheTtlMs: 5 * 60 * 1000,
  baseDir: path.join(__dirname, '..', 'knowledge'),
  fileExtensions: new Set(['.txt', '.md', '.csv', '.json', '.yaml', '.yml']),
  stopWords: new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'bot', 'can', 'do', 'does', 'for',
    'from', 'had', 'has', 'have', 'hello', 'hey', 'hi', 'how', 'i', 'if',
    'in', 'is', 'it', 'just', 'me', 'my', 'nah', 'no', 'not', 'of', 'ok',
    'okay', 'on', 'or', 'our', 'please', 'pls', 'should', 'so', 'sup',
    'take', 'takes', 'tell', 'thanks', 'that', 'the', 'their', 'them', 'there',
    'these', 'they', 'this', 'those', 'to', 'ty', 'use', 'uses', 'using',
    'was', 'we', 'were', 'what', 'whats', 'when', 'where', 'which', 'who',
    'why', 'with', 'yeah', 'yep', 'yes', 'yo', 'you', 'your',
  ]),
};

module.exports = {
  DISCORD_MESSAGE_LIMIT,
  KNOWLEDGE,
  PORT,
  RECENT_MESSAGES_LIMIT,
  RESPONSE_CHANNEL_IDS,
  parseChannelIds,
};

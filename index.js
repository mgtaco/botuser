require('dotenv').config();

// Core Node modules for files, health checks, and paths.
const fs = require('fs/promises');
const http = require('http');
const path = require('path');

// Discord client pieces used by the bot.
const {
  Client,
  Events,
  IntentsBitField,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

const { shouldRespondAndReply } = require('./lib/groq');

// Small web server for uptime checks.
const PORT = Number(process.env.PORT) || 8000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});
server.listen(PORT, () => console.log(`Health check listening on port ${PORT}`));

// Turns comma-separated channel IDs into a fast lookup set.
function parseChannelIds(raw) {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

// Runtime limits and local knowledge settings.
const RECENT_MESSAGES_LIMIT = 8;
const RESPONSE_CHANNEL_IDS = parseChannelIds(
  process.env.RESPONSE_CHANNEL_IDS ?? process.env.RESPONSE_CHANNEL_ID
);
const KNOWLEDGE_CONTEXT_CHAR_LIMIT = 5000;
const KNOWLEDGE_MAX_CHUNKS = 8;
const KNOWLEDGE_CACHE_TTL_MS = 5 * 60 * 1000;
const KNOWLEDGE_BASE_DIR = path.join(__dirname, 'knowledge');
const KNOWLEDGE_FILE_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.yaml', '.yml']);
const KNOWLEDGE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'bot', 'can', 'do', 'does', 'for',
  'from', 'had', 'has', 'have', 'hello', 'hey', 'hi', 'how', 'i', 'if',
  'in', 'is', 'it', 'just', 'me', 'my', 'nah', 'no', 'not', 'of', 'ok',
  'okay', 'on', 'or', 'our', 'please', 'pls', 'should', 'so', 'sup',
  'take', 'takes', 'tell', 'thanks', 'that', 'the', 'their', 'them', 'there',
  'these', 'they', 'this', 'those', 'to', 'ty', 'use', 'uses', 'using',
  'was', 'we', 'were', 'what', 'whats', 'when', 'where', 'which', 'who',
  'why', 'with', 'yeah', 'yep', 'yes', 'yo', 'you', 'your',
]);
const DISCORD_MESSAGE_LIMIT = 2000;

const knowledgeCache = new Map();

// Discord gateway intents required for messages and slash commands.
const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.GuildVoiceStates,
    IntentsBitField.Flags.MessageContent,
  ],
});

// Formats a user message for the chat model.
function formatUserMessage(msg, botId, botName) {
  const name = msg.author?.username ?? 'Unknown';
  const content = (msg.content?.trim() || '(no text)')
    .replace(new RegExp(`<@!?${botId}>`, 'g'), `@${botName}`);
  return `${name}: ${content}`;
}

// Keeps assistant history as plain message text.
function formatAssistantMessage(msg) {
  return msg.content?.trim() || '(no text)';
}

// Uses the server nickname when the bot has one.
function getBotDisplayName(message) {
  return message.guild?.members.me?.displayName ?? message.client.user.username;
}

// Builds recent channel history for the model.
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

// Fits selected knowledge chunks into the prompt budget.
function limitKnowledgeEntries(entries) {
  const selected = [];
  let totalLength = 0;

  for (const entry of entries) {
    const nextLength = totalLength + entry.length + 1;

    if (nextLength > KNOWLEDGE_CONTEXT_CHAR_LIMIT) {
      if (!selected.length) {
        selected.push(entry.slice(0, KNOWLEDGE_CONTEXT_CHAR_LIMIT));
      }

      break;
    }

    selected.push(entry);
    totalLength = nextLength;
  }

  return selected.join('\n\n');
}

// Checks whether a file or folder exists.
async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

// Finds the guild-specific knowledge folder, then the default folder.
async function getKnowledgeDirectory(guildId) {
  const candidates = [
    guildId ? { directory: path.join(KNOWLEDGE_BASE_DIR, guildId), recursive: true } : null,
    { directory: path.join(KNOWLEDGE_BASE_DIR, 'default'), recursive: true },
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(candidate.directory)) return candidate;
  }

  return null;
}

// Stores a chunk plus normalized text used for keyword search.
function makeKnowledgeEntry(file, text, metadata = {}) {
  const searchText = normalizeKnowledgeText(`${file}\n${text}`);

  return {
    text: `[${file}]\n${text}`,
    searchText,
    ...metadata,
  };
}

// Splits Markdown tables into one searchable chunk per row.
function splitMarkdownTable(file, content) {
  const lines = content.split('\n');
  const headerIndex = lines.findIndex((line, index) => (
    line.trim().startsWith('|') &&
    lines[index + 1]?.trim().startsWith('|') &&
    lines[index + 1].includes('---')
  ));

  if (headerIndex < 0) return [];

  const prefix = lines.slice(0, headerIndex).join('\n').trim();
  const header = lines[headerIndex];
  const divider = lines[headerIndex + 1];
  const chunks = [];

  for (let i = headerIndex + 2; i < lines.length; i++) {
    const row = lines[i].trim();
    if (!row.startsWith('|')) continue;

    const text = [prefix, header, divider, row].filter(Boolean).join('\n');

    chunks.push(makeKnowledgeEntry(file, text, {
      type: 'table-row',
      file,
      prefix,
      header,
      divider,
      row,
      rowSearchText: normalizeKnowledgeText(row),
    }));
  }

  return chunks;
}

// Splits Markdown files into chunks by ## headings.
function splitMarkdownSections(file, content) {
  const sections = content
    .split(/\n(?=##\s+)/)
    .map((section) => section.trim())
    .filter((section) => section.startsWith('## '));

  return sections.map((section) => makeKnowledgeEntry(file, section));
}

// Splits plain text into paragraph-sized chunks.
function splitTextBlocks(file, content) {
  return content
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => makeKnowledgeEntry(file, block));
}

// Chooses the best splitter for a knowledge file.
function splitKnowledgeFile(file, content) {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const tableChunks = splitMarkdownTable(file, normalized);
  if (tableChunks.length) return tableChunks;

  const sectionChunks = splitMarkdownSections(file, normalized);
  if (sectionChunks.length) return sectionChunks;

  return splitTextBlocks(file, normalized);
}

// Finds supported knowledge files, including subfolders when enabled.
async function collectKnowledgeFiles(directory, recursive) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory() && recursive) {
      files.push(...await collectKnowledgeFiles(entryPath, recursive));
      continue;
    }

    if (entry.isFile() && KNOWLEDGE_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

// Reads and chunks all knowledge files in a folder.
async function readKnowledgeFiles(directory, recursive) {
  const files = await collectKnowledgeFiles(directory, recursive);
  const knowledgeEntries = [];

  for (const filePath of files) {
    const file = path.relative(directory, filePath).replaceAll('\\', '/');
    const content = (await fs.readFile(filePath, 'utf8')).trim();
    if (!content) continue;

    knowledgeEntries.push(...splitKnowledgeFile(file, content));
  }

  return knowledgeEntries;
}

// Normalizes text for forgiving keyword matches.
function normalizeKnowledgeText(text) {
  return text
    .toLowerCase()
    .replace(/([a-z]+)-(\d+)/g, '$1-$2 $1$2');
}

// Adds simple plural variants to search terms.
function expandKnowledgeTerms(terms) {
  const expanded = new Set(terms);

  for (const term of terms) {
    if (term.endsWith('s') && term.length > 3) {
      expanded.add(term.slice(0, -1));
    }
  }

  return [...expanded];
}

// Extracts simple search terms from the user message.
function getKnowledgeTerms(query) {
  const terms = [...new Set(
    (normalizeKnowledgeText(query).match(/[a-z0-9][a-z0-9./'-]*/g) ?? [])
      .map((term) => term.replace(/^['"]|['"]$/g, ''))
      .filter((term) => term.length > 1 && !KNOWLEDGE_STOP_WORDS.has(term))
  )];

  return expandKnowledgeTerms(terms);
}

// Extracts exact terms worth checking against table rows.
function getTableFilterTerms(query) {
  return [...new Set(
    (normalizeKnowledgeText(query).match(/[a-z0-9][a-z0-9./'-]*/g) ?? [])
      .map((term) => term.replace(/^['"]|['"]$/g, ''))
      .filter((term) => term.length > 1 && !KNOWLEDGE_STOP_WORDS.has(term))
  )];
}

// Escapes user terms before building a regex.
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matches useful terms while avoiding tiny words inside larger words.
function hasKnowledgeTerm(text, term) {
  if (term.length > 2 || /\d/.test(term)) {
    return text.includes(term);
  }

  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}($|[^a-z0-9])`, 'i').test(text);
}

// Scores a chunk by how many query terms it contains.
function scoreKnowledgeEntry(entry, terms) {
  let score = 0;

  for (const term of terms) {
    if (!hasKnowledgeTerm(entry.searchText, term)) continue;
    score += term.length > 3 ? 3 : 1;
  }

  return score;
}

// Rebuilds tables from rows that directly match the query.
function selectTableRowGroups(entries, query) {
  const terms = getTableFilterTerms(query);
  if (!terms.length) return [];

  const groups = new Map();

  for (const entry of entries) {
    if (entry.type !== 'table-row') continue;
    if (!terms.some((term) => hasKnowledgeTerm(entry.rowSearchText, term))) continue;

    const key = `${entry.file}\n${entry.header}`;

    if (!groups.has(key)) {
      groups.set(key, {
        file: entry.file,
        prefix: entry.prefix,
        header: entry.header,
        divider: entry.divider,
        rows: [],
      });
    }

    groups.get(key).rows.push(entry.row);
  }

  return [...groups.values()].map((group) => {
    const table = [group.prefix, group.header, group.divider, ...group.rows]
      .filter(Boolean)
      .join('\n');

    return `[${group.file}]\n${table}`;
  });
}

// Picks the most relevant chunks for the latest message.
function selectKnowledgeEntries(entries, query) {
  const terms = getKnowledgeTerms(query);
  if (!terms.length) return [];

  const tableGroups = selectTableRowGroups(entries, query);
  const rankedEntries = entries
    .filter((entry) => !tableGroups.length || entry.type !== 'table-row')
    .map((entry, index) => ({
      entry,
      index,
      score: scoreKnowledgeEntry(entry, terms),
    }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, KNOWLEDGE_MAX_CHUNKS)
    .map((result) => result.entry.text);

  return [...tableGroups, ...rankedEntries].slice(0, KNOWLEDGE_MAX_CHUNKS);
}

// Logs what the RAG search found for a message.
function logKnowledgeRetrieval({ guildId, query, source, cacheHit, entries, selectedEntries, context }) {
  console.log('\n[RAG] Message received');
  console.log(`[RAG] Guild: ${guildId ?? 'DM'}`);
  console.log(`[RAG] Query: ${query || '(empty)'}`);
  console.log(`[RAG] Source: ${source?.directory ?? '(none)'}`);
  console.log(`[RAG] Cache: ${cacheHit ? 'hit' : 'miss'}`);
  console.log(`[RAG] Loaded chunks: ${entries.length}`);
  console.log(`[RAG] Search terms: ${getKnowledgeTerms(query).join(', ') || '(none)'}`);
  console.log(`[RAG] Table filter terms: ${getTableFilterTerms(query).join(', ') || '(none)'}`);
  console.log(`[RAG] Retrieved chunks: ${selectedEntries.length}`);
  console.log(`[RAG] Context chars: ${context.length}/${KNOWLEDGE_CONTEXT_CHAR_LIMIT}`);

  if (!context) {
    console.log('[RAG] Retrieved knowledge: (none)\n');
    return;
  }

  console.log(`[RAG] Retrieved knowledge sent to model:\n${context}\n[RAG] End retrieved knowledge\n`);
}

// Builds the RAG context for this server and message.
async function buildKnowledgeContext(guildId, query) {
  const cacheKey = guildId ?? 'default';
  const cached = knowledgeCache.get(cacheKey);
  let source = cached?.source ?? null;
  let cacheHit = false;

  let entries;
  if (cached?.expiresAt > Date.now()) {
    cacheHit = true;
    entries = cached.entries;
  } else {
    source = await getKnowledgeDirectory(guildId);
    if (!source) {
      logKnowledgeRetrieval({
        guildId,
        query,
        source,
        cacheHit,
        entries: [],
        selectedEntries: [],
        context: '',
      });
      return '';
    }

    try {
      entries = await readKnowledgeFiles(source.directory, source.recursive);
    } catch (err) {
      console.warn(`Failed to read knowledge directory ${source.directory}: ${err.message}`);
      return '';
    }

    knowledgeCache.set(cacheKey, {
      expiresAt: Date.now() + KNOWLEDGE_CACHE_TTL_MS,
      entries,
      source,
    });
  }

  const selectedEntries = selectKnowledgeEntries(entries, query);
  const context = limitKnowledgeEntries(selectedEntries);

  logKnowledgeRetrieval({
    guildId,
    query,
    source,
    cacheHit,
    entries,
    selectedEntries,
    context,
  });

  return context;
}

// Splits long replies so Discord accepts them.
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

// Checks whether a URL is likely to create an image preview.
function isImagePreviewUrl(url) {
  return /\.(png|jpe?g|gif|webp|avif)(?:[/?#]|$)/i.test(url);
}

// Detects image links that Discord can preview.
function hasImagePreviewLink(content) {
  const linkPattern = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>)]+)/g;
  let match;

  while ((match = linkPattern.exec(content)) !== null) {
    const url = match[2] ?? match[3];
    if (isImagePreviewUrl(url)) return true;
  }

  return false;
}

// Splits after image-link lines so previews stay with the item text.
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

// Sends one or more Discord messages for a reply.
async function sendReply(channel, reply) {
  for (const message of splitReplyAfterImageLinkLines(reply)) {
    for (const chunk of splitDiscordMessage(message)) {
      await channel.send(chunk);
    }
  }
}

// Warns if configured channel IDs cannot be fetched.
async function validateChannelIds(discordClient, ids, label) {
  if (!ids.size) return;

  const missing = [];

  for (const id of ids) {
    try {
      const channel = await discordClient.channels.fetch(id);
      if (!channel) missing.push(id);
    } catch {
      missing.push(id);
    }
  }

  if (missing.length) {
    console.warn(`${label} channel ID(s) not found or inaccessible: ${missing.join(', ')}`);
  }
}

// Runs once after Discord login.
client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  await validateChannelIds(c, RESPONSE_CHANNEL_IDS, 'Response');

  const clearCommand = new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear recent messages in this channel')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(c.user.id), {
    body: [clearCommand.toJSON()],
  }).catch((err) => {
    console.error('Failed to register slash command:', err.message);
  });
});

// Main AI reply handler.
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (RESPONSE_CHANNEL_IDS.size && !RESPONSE_CHANNEL_IDS.has(message.channelId)) return;

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
});

// Handles the /clear moderation command.
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'clear') return;

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
});

// Start the bot.
const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('DISCORD_TOKEN is not set. Copy .env.example to .env and add your token.');
  process.exit(1);
}

client.login(token).catch((err) => {
  console.error('Login failed:', err.message);
  process.exit(1);
});

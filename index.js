require('dotenv').config();

const http = require('http');

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

const PORT = Number(process.env.PORT) || 8000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});
server.listen(PORT, () => console.log(`Health check listening on port ${PORT}`));

function parseChannelIds(raw) {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

const RECENT_MESSAGES_LIMIT = 15;
const RESPONSE_CHANNEL_IDS = parseChannelIds(
  process.env.RESPONSE_CHANNEL_IDS ?? process.env.RESPONSE_CHANNEL_ID
);
const KNOWLEDGE_CHANNEL_IDS = parseChannelIds(
  process.env.KNOWLEDGE_CHANNEL_IDS ?? process.env.KNOWLEDGE_CHANNEL_ID
);
const KNOWLEDGE_MESSAGES_LIMIT = 50;
const KNOWLEDGE_CONTEXT_CHAR_LIMIT = 16000;
const KNOWLEDGE_ATTACHMENT_SIZE_LIMIT = 500000;
const KNOWLEDGE_ATTACHMENT_CHAR_LIMIT = 12000;
const KNOWLEDGE_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCORD_MESSAGE_LIMIT = 2000;

let knowledgeCache = {
  expiresAt: 0,
  context: '',
};

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.GuildVoiceStates,
    IntentsBitField.Flags.MessageContent,
  ],
});

function formatMessage(msg, botId, botName) {
  const name = msg.author?.username ?? 'Unknown';
  const content = (msg.content?.trim() || '(no text)')
    .replace(new RegExp(`<@!?${botId}>`, 'g'), `@${botName}`);
  return `${name}: ${content}`;
}

function getBotDisplayName(message) {
  return message.guild?.members.me?.displayName ?? message.client.user.username;
}

async function buildConversationMessages(channel, botId, botName) {
  const messages = await channel.messages.fetch({ limit: RECENT_MESSAGES_LIMIT });

  const sorted = [...messages.values()].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );

  return sorted.map((msg) => ({
    role: msg.author.id === botId ? 'assistant' : 'user',
    content: formatMessage(msg, botId, botName),
  }));
}

function limitKnowledgeEntries(entries) {
  const selected = [];
  let totalLength = 0;

  for (let i = entries.length - 1; i >= 0; i--) {
    const nextLength = totalLength + entries[i].length + 1;

    if (nextLength > KNOWLEDGE_CONTEXT_CHAR_LIMIT) {
      if (!selected.length) {
        selected.unshift(entries[i].slice(0, KNOWLEDGE_CONTEXT_CHAR_LIMIT));
      }

      break;
    }

    selected.unshift(entries[i]);
    totalLength = nextLength;
  }

  return selected.join('\n');
}

function isKnowledgeTextAttachment(attachment) {
  const name = (attachment.name ?? '').toLowerCase();
  const contentType = (attachment.contentType ?? '').toLowerCase();

  return (
    contentType.startsWith('text/') ||
    contentType === 'application/json' ||
    ['.txt', '.md', '.csv', '.json', '.yaml', '.yml'].some((extension) => name.endsWith(extension))
  );
}

async function readKnowledgeAttachment(attachment) {
  if (!isKnowledgeTextAttachment(attachment)) return '';

  if (attachment.size > KNOWLEDGE_ATTACHMENT_SIZE_LIMIT) {
    console.warn(`Skipping large knowledge attachment ${attachment.name}: ${attachment.size} bytes`);
    return '';
  }

  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return (await response.text()).trim().slice(0, KNOWLEDGE_ATTACHMENT_CHAR_LIMIT);
}

async function buildKnowledgeContext(discordClient) {
  if (!KNOWLEDGE_CHANNEL_IDS.size) return '';
  if (knowledgeCache.expiresAt > Date.now()) return knowledgeCache.context;

  const entries = [];

  for (const id of KNOWLEDGE_CHANNEL_IDS) {
    try {
      const channel = await discordClient.channels.fetch(id);
      if (!channel || typeof channel.messages?.fetch !== 'function') continue;

      const messages = await channel.messages.fetch({ limit: KNOWLEDGE_MESSAGES_LIMIT });
      const channelName = channel.name ?? id;

      for (const msg of messages.values()) {
        const content = msg.content?.trim();

        if (content) {
          entries.push({
            createdTimestamp: msg.createdTimestamp,
            text: `[${channelName}] ${msg.author?.username ?? 'Unknown'}: ${content}`,
          });
        }

        for (const attachment of msg.attachments.values()) {
          try {
            const attachmentText = await readKnowledgeAttachment(attachment);
            if (!attachmentText) continue;

            entries.push({
              createdTimestamp: msg.createdTimestamp,
              text: `[${channelName}] ${attachment.name ?? 'attachment'}:\n${attachmentText}`,
            });
          } catch (err) {
            console.warn(`Failed to read knowledge attachment ${attachment.name ?? attachment.id}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`Failed to read knowledge channel ${id}: ${err.message}`);
    }
  }

  const context = limitKnowledgeEntries(
    entries
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((entry) => entry.text)
  );

  knowledgeCache = {
    expiresAt: Date.now() + KNOWLEDGE_CACHE_TTL_MS,
    context,
  };

  return context;
}

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

async function sendReply(channel, reply) {
  for (const chunk of splitDiscordMessage(reply)) {
    await channel.send(chunk);
  }
}

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

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  await validateChannelIds(c, RESPONSE_CHANNEL_IDS, 'Response');
  await validateChannelIds(c, KNOWLEDGE_CHANNEL_IDS, 'Knowledge');

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

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (RESPONSE_CHANNEL_IDS.size && !RESPONSE_CHANNEL_IDS.has(message.channelId)) return;

  const botName = getBotDisplayName(message);

  const turns = await buildConversationMessages(
    message.channel,
    message.client.user.id,
    botName
  );
  const knowledgeContext = await buildKnowledgeContext(message.client);

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

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'clear') return;

  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const channel = interaction.channel;

  const sendChannelMessage = async (content) => {
    if (typeof channel?.send !== 'function') return;
    await channel.send(content).catch(() => {});
  };

  if (typeof channel?.bulkDelete !== 'function') {
    await sendChannelMessage("Can't clear messages in this channel.");
    await interaction.deleteReply().catch(() => {});
    return;
  }

  try {
    const deleted = await channel.bulkDelete(100, true);
    await sendChannelMessage(`Cleared ${deleted.size} message(s).`);
  } catch (err) {
    console.error('Clear error:', err.message);
    await sendChannelMessage(`Failed: ${err.message}`);
  } finally {
    await interaction.deleteReply().catch(() => {});
  }
});

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('DISCORD_TOKEN is not set. Copy .env.example to .env and add your token.');
  process.exit(1);
}

client.login(token).catch((err) => {
  console.error('Login failed:', err.message);
  process.exit(1);
});

const path = require('path');
const { KNOWLEDGE } = require('../config');
const { findKnowledgeChannel } = require('../discord/channelConfig');

const KNOWLEDGE_CONTEXT_CHAR_LIMIT = KNOWLEDGE.contextCharLimit;
const KNOWLEDGE_MAX_CHUNKS = KNOWLEDGE.maxChunks;
const KNOWLEDGE_CACHE_TTL_MS = KNOWLEDGE.cacheTtlMs;
const KNOWLEDGE_MESSAGE_FETCH_LIMIT = KNOWLEDGE.messageFetchLimit;
const KNOWLEDGE_FILE_EXTENSIONS = KNOWLEDGE.fileExtensions;
const KNOWLEDGE_STOP_WORDS = KNOWLEDGE.stopWords;

const knowledgeCache = new Map();

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


function makeKnowledgeEntry(file, text, metadata = {}) {
  const searchText = normalizeKnowledgeText(`${file}\n${text}`);

  return {
    text: `[${file}]\n${text}`,
    searchText,
    ...metadata,
  };
}

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

function splitMarkdownSections(file, content) {
  const sections = content
    .split(/\n(?=##\s+)/)
    .map((section) => section.trim())
    .filter((section) => section.startsWith('## '));

  return sections.map((section) => makeKnowledgeEntry(file, section));
}

function splitTextBlocks(file, content) {
  return content
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => makeKnowledgeEntry(file, block));
}

function splitKnowledgeFile(file, content) {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const tableChunks = splitMarkdownTable(file, normalized);
  if (tableChunks.length) return tableChunks;

  const sectionChunks = splitMarkdownSections(file, normalized);
  if (sectionChunks.length) return sectionChunks;

  return splitTextBlocks(file, normalized);
}

function isTextAttachment(attachment) {
  const name = attachment.name ?? '';
  return KNOWLEDGE_FILE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

async function fetchAttachmentText(attachment) {
  try {
    const res = await fetch(attachment.url);
    if (!res.ok) return '';
    return (await res.text()).trim();
  } catch (err) {
    console.warn(`Failed to download knowledge attachment ${attachment.name}: ${err.message}`);
    return '';
  }
}

// Reads the recent messages of the tagged knowledge channel and turns their
// text content and text attachments into searchable knowledge entries.
async function readKnowledgeFromChannel(channel) {
  const fetched = await channel.messages.fetch({ limit: KNOWLEDGE_MESSAGE_FETCH_LIMIT });

  // Oldest-first so knowledge keeps a stable, readable order.
  const messages = [...fetched.values()].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );

  const knowledgeEntries = [];

  for (const message of messages) {
    if (message.author.bot) continue;

    const content = message.content?.trim();
    if (content) {
      knowledgeEntries.push(...splitKnowledgeFile(`msg-${message.id}`, content));
    }

    for (const attachment of message.attachments.values()) {
      if (!isTextAttachment(attachment)) continue;

      const text = await fetchAttachmentText(attachment);
      if (text) knowledgeEntries.push(...splitKnowledgeFile(attachment.name, text));
    }
  }

  return knowledgeEntries;
}

function normalizeKnowledgeText(text) {
  return text
    .toLowerCase()
    .replace(/([a-z]+)-(\d+)/g, '$1-$2 $1$2');
}

function expandKnowledgeTerms(terms) {
  const expanded = new Set(terms);

  for (const term of terms) {
    if (term.endsWith('s') && term.length > 3) {
      expanded.add(term.slice(0, -1));
    }
  }

  return [...expanded];
}

function getKnowledgeTerms(query) {
  const terms = [...new Set(
    (normalizeKnowledgeText(query).match(/[a-z0-9][a-z0-9./'-]*/g) ?? [])
      .map((term) => term.replace(/^['"]|['"]$/g, ''))
      .filter((term) => term.length > 1 && !KNOWLEDGE_STOP_WORDS.has(term))
  )];

  return expandKnowledgeTerms(terms);
}

function getTableFilterTerms(query) {
  return [...new Set(
    (normalizeKnowledgeText(query).match(/[a-z0-9][a-z0-9./'-]*/g) ?? [])
      .map((term) => term.replace(/^['"]|['"]$/g, ''))
      .filter((term) => term.length > 1 && !KNOWLEDGE_STOP_WORDS.has(term))
  )];
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasKnowledgeTerm(text, term) {
  if (term.length > 2 || /\d/.test(term)) {
    return text.includes(term);
  }

  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}($|[^a-z0-9])`, 'i').test(text);
}

function scoreKnowledgeEntry(entry, terms) {
  let score = 0;

  for (const term of terms) {
    if (!hasKnowledgeTerm(entry.searchText, term)) continue;
    score += term.length > 3 ? 3 : 1;
  }

  return score;
}

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

function logKnowledgeRetrieval({ guildId, query, source, cacheHit, entries, selectedEntries, context }) {
  console.log('\n[RAG] Message received');
  console.log(`[RAG] Guild: ${guildId ?? 'DM'}`);
  console.log(`[RAG] Query: ${query || '(empty)'}`);
  console.log(`[RAG] Source: ${source ?? '(none)'}`);
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

async function buildKnowledgeContext(guild, query) {
  const guildId = guild?.id ?? null;

  // Knowledge lives in a tagged channel of a guild; DMs have no knowledge.
  const channel = findKnowledgeChannel(guild);
  if (!channel) {
    logKnowledgeRetrieval({
      guildId,
      query,
      source: null,
      cacheHit: false,
      entries: [],
      selectedEntries: [],
      context: '',
    });
    return '';
  }

  const source = `#${channel.name}`;
  const cacheKey = channel.id;
  const cached = knowledgeCache.get(cacheKey);
  let cacheHit = false;

  let entries;
  if (cached?.expiresAt > Date.now()) {
    cacheHit = true;
    entries = cached.entries;
  } else {
    try {
      entries = await readKnowledgeFromChannel(channel);
    } catch (err) {
      console.warn(`Failed to read knowledge channel ${source}: ${err.message}`);
      return '';
    }

    knowledgeCache.set(cacheKey, {
      expiresAt: Date.now() + KNOWLEDGE_CACHE_TTL_MS,
      entries,
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

module.exports = {
  buildKnowledgeContext,
  getKnowledgeTerms,
  readKnowledgeFromChannel,
  selectKnowledgeEntries,
  splitKnowledgeFile,
};

const Groq = require('groq-sdk');

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

const GROQ_MODEL = 'openai/gpt-oss-120b';
const MAX_RESPONSE_TOKENS = 1024;

const PERSONA_PROMPT = 'You are a friendly Discord bot. Be casual and Gen Z, use some emojis when it fits. Keep replies concise unless the user asks for detail.';

const WHEN_TO_RESPOND_PROMPT = `When to respond:
- When someone talks to you directly (e.g. mentions you or replies to your message).
- When the conversation is clearly directed at you or asks you a question.
Otherwise reply with an empty string so the bot stays quiet.`;

const RULES_PROMPT = `Rules:
- Don't make things up. If you don't know, say so.
- Don't repeat what the user said back at them.
- You may use Discord markdown when its suitable.
- Discord markdown examples you can use:
  - **bold**
  - *italic*
  - __underline__
  - ~~strikethrough~~
  - ||spoiler||
  - \`inline code\`
  - \`\`\`js
    const answer = 42;
    \`\`\`
  - > block quote
  - - list item
  - 1. numbered item
  - [link text](https://example.com)
- Reply only with valid JSON in this exact format:
{"reply": "your message here"}`;

function buildSystemPrompt(botName, forceReply, knowledgeContext) {
  const responseMode = forceReply
    ? 'The latest message mentions you, uses your name, or replies to you. Answer it.'
    : `${WHEN_TO_RESPOND_PROMPT}\n\nIf you have nothing to say, use: {"reply": ""}`;

  const parts = [
    PERSONA_PROMPT,
    responseMode,
  ];

  if (knowledgeContext) {
    parts.push(`Server/game reference info:\n${knowledgeContext}\n\nUse this info when it helps answer server or game questions. If the answer is not in the chat history or reference info, say you don't know.`);
  }

  parts.push(
    RULES_PROMPT,
    `Your name is ${botName}.`
  );

  return parts.join('\n\n');
}

function escapeControlCharsInReplyValue(raw) {
  if (typeof raw !== 'string') return raw;
  return raw
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

async function shouldRespondAndReply(context) {
  const { messages: turns, botName, forceReply, knowledgeContext } = context;
  const system = buildSystemPrompt(botName, forceReply, knowledgeContext);

  const completion = await client.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: system },
      ...turns
    ],
    temperature: 0.7,
    max_tokens: MAX_RESPONSE_TOKENS,
  });

  const content = completion.choices?.[0]?.message?.content?.trim();

  if (!content) return { reply: '' };

  const escaped = escapeControlCharsInReplyValue(content);

  let data;
  try {
    data = JSON.parse(escaped);
  } catch {
    return { reply: '' };
  }

  const reply = typeof data.reply === 'string' ? data.reply : '';
  return { reply };
}

module.exports = { shouldRespondAndReply };

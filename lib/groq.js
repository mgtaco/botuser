const Groq = require('groq-sdk');

// Groq client and model settings.
const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

const GROQ_MODEL = 'openai/gpt-oss-120b';
const MAX_RESPONSE_TOKENS = 1024;

// Builds the system prompt sent with each request.
function buildSystemPrompt(botName, knowledgeContext) {
  const parts = [
    `### Role
You are ${botName}, a friendly Discord bot for this server. Be casual and lightly Gen Z. Keep replies concise unless the user asks for detail.`,

    `### Instructions
- Always answer the latest user message.
- If the latest user message is casual chat rather than a question, respond naturally and briefly.
- Use the chat history to understand the latest message.
- Use the server/game reference only when it helps answer server or game questions.
- If the answer is not in the chat history or reference info, say you don't know.
- Do not repeat the user's message back at them.
- Discord markdown is allowed when useful: **bold**, *italic*, \`inline code\`, code blocks, quotes, lists, links, and ||spoilers||.`,
  ];

  if (knowledgeContext) {
    parts.push(`### Context
Server/game reference info is delimited below.

<<<SERVER_GAME_REFERENCE
${knowledgeContext}
SERVER_GAME_REFERENCE>>>`);
  }

  parts.push(`### Expected Output
Return only the message text to send in Discord. Do not wrap it in JSON.`);

  return parts.join('\n\n');
}

// Calls Groq and returns the text reply.
async function shouldRespondAndReply(context) {
  const { messages: turns, botName, knowledgeContext } = context;
  const system = buildSystemPrompt(botName, knowledgeContext);

  const completion = await client.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: system },
      ...turns
    ],
    temperature: 0.7,
    max_tokens: MAX_RESPONSE_TOKENS,
  });

  const reply = completion.choices?.[0]?.message?.content?.trim() ?? '';
  return { reply };
}

module.exports = { shouldRespondAndReply };

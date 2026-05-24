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

module.exports = { validateChannelIds };

const DISCORD_API = "https://discord.com/api/v10";
const CACHE_DURATION_MS = 5 * 60 * 1000;

interface CachedGuildName {
  name: string;
  expiresAt: number;
}

interface DiscordGuild {
  name?: string;
}

const guildNameCache = new Map<string, CachedGuildName>();

export async function resolveGuildNames(
  guildIds: string[],
  botToken: string,
  request: typeof fetch = fetch,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const uncachedIds: string[] = [];

  for (const guildId of new Set(guildIds)) {
    const cached = guildNameCache.get(guildId);
    if (cached && cached.expiresAt > Date.now()) {
      names.set(guildId, cached.name);
    } else {
      guildNameCache.delete(guildId);
      uncachedIds.push(guildId);
    }
  }

  const resolved = await Promise.all(uncachedIds.map(async (guildId) => {
    const response = await request(`${DISCORD_API}/guilds/${encodeURIComponent(guildId)}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });

    if (response.status === 404) {
      return [guildId, "Unavailable server"] as const;
    }
    if (!response.ok) {
      throw new Error(
        `Discord guild lookup failed (${response.status}): ${await response.text()}`,
      );
    }

    const guild = (await response.json()) as DiscordGuild;
    if (!guild.name?.trim()) {
      throw new Error("Discord returned a guild without a name.");
    }

    const name = guild.name.trim();
    guildNameCache.set(guildId, {
      name,
      expiresAt: Date.now() + CACHE_DURATION_MS,
    });
    return [guildId, name] as const;
  }));

  for (const [guildId, name] of resolved) names.set(guildId, name);
  return names;
}

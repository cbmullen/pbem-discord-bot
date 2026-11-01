const DISCORD_API = "https://discord.com/api/v10";
const CACHE_DURATION_MS = 5 * 60 * 1000;
const MAX_CONCURRENT_GUILD_LOOKUPS = 5;

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
  const now = Date.now();

  for (const [guildId, cached] of guildNameCache) {
    if (cached.expiresAt <= now) guildNameCache.delete(guildId);
  }

  for (const guildId of new Set(guildIds)) {
    const cached = guildNameCache.get(guildId);
    if (cached) {
      names.set(guildId, cached.name);
    } else {
      uncachedIds.push(guildId);
    }
  }

  async function resolveName(guildId: string): Promise<string> {
    const response = await request(`${DISCORD_API}/guilds/${encodeURIComponent(guildId)}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });

    if (response.status === 403 || response.status === 404 || response.status === 429) {
      return "Unavailable server";
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
    return name;
  }

  let nextIndex = 0;
  await Promise.all(Array.from(
    { length: Math.min(MAX_CONCURRENT_GUILD_LOOKUPS, uncachedIds.length) },
    async () => {
      while (nextIndex < uncachedIds.length) {
        const guildId = uncachedIds[nextIndex++]!;
        names.set(guildId, await resolveName(guildId));
      }
    },
  ));
  return names;
}

const DISCORD_API = "https://discord.com/api/v10";
const CACHE_DURATION_MS = 5 * 60 * 1000;
const MAX_CONCURRENT_GUILD_LOOKUPS = 5;
const GUILD_LOOKUP_TIMEOUT_MS = 10_000;
const MAX_RATE_LIMIT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;

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
    const url = `${DISCORD_API}/guilds/${encodeURIComponent(guildId)}`;
    const deadline = Date.now() + GUILD_LOOKUP_TIMEOUT_MS;
    let response: Response;

    for (let retry = 0; ; retry += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("Discord guild lookup timed out.");
      response = await request(url, {
        headers: { Authorization: `Bot ${botToken}` },
        signal: AbortSignal.timeout(remainingMs),
      });
      if (response.status !== 429 || retry >= MAX_RATE_LIMIT_RETRIES) break;

      const retryAfter = response.headers.get("Retry-After");
      const retryAfterMs = retryAfter === null
        ? DEFAULT_RETRY_DELAY_MS
        : Number.isFinite(Number(retryAfter))
          ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - Date.now();
      const delayMs = Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? retryAfterMs
        : DEFAULT_RETRY_DELAY_MS;
      if (Date.now() + delayMs >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

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

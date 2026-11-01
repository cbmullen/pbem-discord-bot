import { createHmac } from "node:crypto";
import {
  getPublicArchiveStatistics,
  listPublicActiveGames,
  listPublicArchivedGames,
  openRepository,
} from "../src/database/repository.js";
import { resolveGuildNames } from "../src/discord/guild-names.js";
import {
  methodNotAllowedResponse,
  publicJsonResponse,
  publicOptionsResponse,
} from "../src/http/public-api.js";
import { addServerNames, summarizePublicArchives } from "../src/http/public-games.js";

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return publicOptionsResponse();
    if (request.method !== "GET") return methodNotAllowedResponse();

    const databaseUrl = process.env.DATABASE_URL?.trim();
    const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
    if (!databaseUrl || !botToken) {
      return publicJsonResponse({ error: "Status data is unavailable." }, 503);
    }

    try {
      const clientIp =
        request.headers.get("x-vercel-forwarded-for")?.trim() ||
        request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ||
        "unknown";
      const clientKey = createHmac("sha256", databaseUrl).update(clientIp).digest("hex");
      const rateLimit = await openRepository(databaseUrl)
        .checkPublicApiRateLimit(clientKey, 60);
      if (!rateLimit.allowed) {
        return publicJsonResponse(
          { error: "Too many status requests. Try again shortly." },
          429,
          {
            "Cache-Control": "no-store",
            "Retry-After": String(rateLimit.retryAfterSeconds),
          },
        );
      }

      const [games, archives, statistics] = await Promise.all([
        listPublicActiveGames(databaseUrl),
        listPublicArchivedGames(databaseUrl),
        getPublicArchiveStatistics(databaseUrl),
      ]);
      const guildNames = await resolveGuildNames(
        [...games.map((game) => game.guildId), ...archives.map((game) => game.guildId)],
        botToken,
      );
      const summary = summarizePublicArchives(archives, guildNames, statistics);
      return publicJsonResponse(
        {
          generatedAt: new Date().toISOString(),
          games: addServerNames(games, guildNames),
          ...summary,
        },
        200,
        { "Cache-Control": "public, s-maxage=60" },
      );
    } catch (error) {
      console.error("Could not load public PBEM status:", error);
      return publicJsonResponse({ error: "Status data is unavailable." }, 503);
    }
  },
};

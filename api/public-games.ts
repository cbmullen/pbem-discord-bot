import {
  listPublicActiveGames,
  listPublicArchivedGames,
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
      const games = await listPublicActiveGames(databaseUrl);
      const archives = await listPublicArchivedGames(databaseUrl);
      const guildNames = await resolveGuildNames(
        [...games.map((game) => game.guildId), ...archives.map((game) => game.guildId)],
        botToken,
      );
      const summary = summarizePublicArchives(archives, guildNames);
      return publicJsonResponse({
        generatedAt: new Date().toISOString(),
        games: addServerNames(games, guildNames),
        ...summary,
      });
    } catch (error) {
      console.error("Could not load public PBEM status:", error);
      return publicJsonResponse({ error: "Status data is unavailable." }, 503);
    }
  },
};

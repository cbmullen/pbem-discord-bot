import { listPublicActiveGames } from "../src/database/repository.js";
import {
  methodNotAllowedResponse,
  publicJsonResponse,
  publicOptionsResponse,
} from "../src/http/public-api.js";

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return publicOptionsResponse();
    if (request.method !== "GET") return methodNotAllowedResponse();

    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) {
      return publicJsonResponse({ error: "Status data is unavailable." }, 503);
    }

    try {
      const games = await listPublicActiveGames(databaseUrl);
      return publicJsonResponse({
        generatedAt: new Date().toISOString(),
        games,
      });
    } catch (error) {
      console.error("Could not load public PBEM status:", error);
      return publicJsonResponse({ error: "Status data is unavailable." }, 503);
    }
  },
};

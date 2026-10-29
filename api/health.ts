import { neon } from "@neondatabase/serverless";
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
      return publicJsonResponse({ status: "unhealthy" }, 503);
    }

    try {
      await neon(databaseUrl)`SELECT 1`;
      return publicJsonResponse({ status: "healthy" });
    } catch (error) {
      console.error("PBEM health check failed:", error);
      return publicJsonResponse({ status: "unhealthy" }, 503);
    }
  },
};

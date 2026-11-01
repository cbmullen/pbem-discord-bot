import { openRepository } from "../src/database/repository.js";

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET" },
      });
    }

    const cronSecret = process.env.CRON_SECRET?.trim();
    if (!cronSecret) {
      console.error("Interaction cleanup endpoint is missing CRON_SECRET.");
      return Response.json({ error: "Service unavailable" }, { status: 503 });
    }
    if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) {
      console.error("Interaction cleanup requires DATABASE_URL.");
      return Response.json({ error: "Service unavailable" }, { status: 503 });
    }

    try {
      const repository = openRepository(databaseUrl);
      const removedInteractions = await repository.sweepExpiredInteractions();
      const removedRateLimits = await repository.sweepExpiredPublicApiRateLimits();
      console.log(
        `Removed ${removedInteractions} expired Discord interaction record(s) and ${removedRateLimits} public API rate-limit record(s).`,
      );
      return Response.json({ removedInteractions, removedRateLimits });
    } catch (error) {
      console.error("Could not remove expired Discord interaction records:", error);
      return Response.json({ error: "Cleanup failed" }, { status: 500 });
    }
  },
};

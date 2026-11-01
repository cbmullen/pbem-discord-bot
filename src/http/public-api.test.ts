import assert from "node:assert/strict";
import test from "node:test";
import {
  methodNotAllowedResponse,
  publicJsonResponse,
  publicOptionsResponse,
} from "./public-api.js";
import healthRoute from "../../api/health.js";
import publicGamesRoute from "../../api/public-games.js";
import { resolveGuildNames } from "../discord/guild-names.js";
import { addServerNames, summarizePublicArchives } from "./public-games.js";

test("public API responses allow anonymous cross-origin reads without credentials", async () => {
  const response = publicJsonResponse({ status: "healthy" });
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, OPTIONS");
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null);
  assert.deepEqual(await response.json(), { status: "healthy" });
});

test("public API responses can override caching headers without losing CORS", () => {
  const response = publicJsonResponse(
    { status: "healthy" },
    200,
    { "Cache-Control": "public, s-maxage=60" },
  );
  assert.equal(response.headers.get("Cache-Control"), "public, s-maxage=60");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
});

test("public API preflight requests are accepted", () => {
  const response = publicOptionsResponse();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
});

test("public API rejects unsupported methods", async () => {
  const response = methodNotAllowedResponse();
  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), { error: "Method not allowed." });
});

test("public routes handle CORS preflight without contacting the database", async () => {
  for (const route of [healthRoute, publicGamesRoute]) {
    const response = await route.fetch(new Request("https://bot.example/api", {
      method: "OPTIONS",
    }));
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  }
});

test("public routes reject write methods", async () => {
  for (const route of [healthRoute, publicGamesRoute]) {
    const response = await route.fetch(new Request("https://bot.example/api", {
      method: "POST",
    }));
    assert.equal(response.status, 405);
  }
});

test("guild names are resolved using the bot without returning guild IDs in page data", async () => {
  const guildId = `test-guild-${Date.now()}`;
  let requestedUrl = "";
  let authorization = "";
  const names = await resolveGuildNames([guildId, guildId], "test-token", async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("Authorization") ?? "";
    return Response.json({ name: "Example server" });
  });

  assert.equal(names.size, 1);
  assert.equal(names.get(guildId), "Example server");
  assert.equal(requestedUrl, `https://discord.com/api/v10/guilds/${guildId}`);
  assert.equal(authorization, "Bot test-token");
});

test("missing Discord guilds receive a non-identifying public label", async () => {
  const guildId = `missing-guild-${Date.now()}`;
  const names = await resolveGuildNames([guildId], "test-token", async () =>
    new Response(null, { status: 404 }),
  );
  assert.equal(names.get(guildId), "Unavailable server");
});

test("inaccessible Discord guilds do not prevent public status from resolving other names", async () => {
  const inaccessibleGuildId = `inaccessible-guild-${Date.now()}`;
  const availableGuildId = `available-guild-${Date.now()}`;
  const names = await resolveGuildNames(
    [inaccessibleGuildId, availableGuildId],
    "test-token",
    async (input) =>
      String(input).includes(inaccessibleGuildId)
        ? new Response(null, { status: 403 })
        : Response.json({ name: "Available server" }),
  );
  assert.equal(names.get(inaccessibleGuildId), "Unavailable server");
  assert.equal(names.get(availableGuildId), "Available server");
});

test("Discord throttling labels only that server as unavailable", async () => {
  const throttledGuildId = `throttled-guild-${Date.now()}`;
  const availableGuildId = `unthrottled-guild-${Date.now()}`;
  const names = await resolveGuildNames(
    [throttledGuildId, availableGuildId],
    "test-token",
    async (input) =>
      String(input) === `https://discord.com/api/v10/guilds/${throttledGuildId}`
        ? new Response(null, { status: 429, headers: { "Retry-After": "1" } })
        : Response.json({ name: "Available server" }),
  );
  assert.equal(names.get(throttledGuildId), "Unavailable server");
  assert.equal(names.get(availableGuildId), "Available server");
});

test("guild name lookups are limited to five concurrent Discord requests", async () => {
  const guildIds = Array.from({ length: 12 }, (_, index) =>
    `concurrency-test-${Date.now()}-${index}`,
  );
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const names = await resolveGuildNames(guildIds, "test-token", async () => {
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeRequests -= 1;
    return Response.json({ name: "Example server" });
  });

  assert.equal(names.size, guildIds.length);
  assert.equal(maxActiveRequests, 5);
});

test("public game data includes server names without guild IDs", () => {
  const [game] = addServerNames(
    [{
      guildId: "private-guild-id",
      name: "Example game",
      mode: "consecutive",
      activeMode: "consecutive",
      reminderDays: 3,
      createdAt: "2026-10-29T12:00:00.000Z",
      players: [],
    }],
    new Map([["private-guild-id", "Example server"]]),
  );
  assert.equal(game?.serverName, "Example server");
  assert.equal(game?.name, "Example game");
  assert.equal(game?.reminderDays, 3);
  assert.equal("guildId" in (game ?? {}), false);
});

test("public archive statistics count shared-team wins for every member without exposing IDs", () => {
  const summary = summarizePublicArchives(
    [{
      gameId: "private-game-id",
      name: "Archived game",
      mode: "simultaneous",
      activeMode: "simultaneous",
      reminderDays: 0,
      guildId: "private-guild-id",
      channelId: "private-channel-id",
      messageId: null,
      createdBy: "private-creator-id",
      createdAt: "2026-10-30T00:00:00.000Z",
      completedAt: "2026-11-01T00:00:00.000Z",
      winnerUserId: "jill-id",
      players: [
        {
          userId: "jill-id",
          username: "Jill / Jack",
          notificationUserIds: ["jill-id", "jack-id"],
          notificationUsernames: ["Jill", "Jack"],
          position: 0,
          status: "done",
          pendingSince: null,
          lastUpdatedAt: "2026-10-31T00:00:00.000Z",
          completedTurns: 2,
          totalTurnDurationMs: 8 * 60 * 60 * 1000,
        },
        {
          userId: "sam-id",
          username: "Sam",
          position: 1,
          status: "done",
          pendingSince: null,
          lastUpdatedAt: "2026-10-31T00:00:00.000Z",
          completedTurns: 1,
          totalTurnDurationMs: 3 * 60 * 60 * 1000,
        },
      ],
      events: [{ type: "player_marked_done" }],
    }],
    new Map([["private-guild-id", "Example server"]]),
  );

  assert.equal(summary.completedGames[0]?.winner, "Jill / Jack");
  assert.equal(summary.completedGames[0]?.durationMs, 2 * 24 * 60 * 60 * 1000);
  assert.equal(summary.completedGames[0]?.completedTurns, 3);
  assert.equal(
    summary.completedGames[0]?.averageTurnDurationMs,
    (11 * 60 * 60 * 1000) / 3,
  );
  assert.deepEqual(
    summary.playerStats.map(({ username, wins, gamesPlayed, completedTurns, averageTurnDurationMs }) => ({
      username,
      wins,
      gamesPlayed,
      completedTurns,
      averageTurnDurationMs,
    })),
    [
      {
        username: "Jack",
        wins: 1,
        gamesPlayed: 1,
        completedTurns: 2,
        averageTurnDurationMs: 4 * 60 * 60 * 1000,
      },
      {
        username: "Jill",
        wins: 1,
        gamesPlayed: 1,
        completedTurns: 2,
        averageTurnDurationMs: 4 * 60 * 60 * 1000,
      },
      {
        username: "Sam",
        wins: 0,
        gamesPlayed: 1,
        completedTurns: 1,
        averageTurnDurationMs: 3 * 60 * 60 * 1000,
      },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(summary),
    /jill-id|jack-id|private-guild-id|private-game-id|private-creator-id/,
  );
});

test("public archive summaries keep global statistics separate from recent history", () => {
  const summary = summarizePublicArchives([], new Map(), {
    playerStats: [{
      userId: "private-user-id",
      username: "Jill",
      gamesPlayed: 125,
      wins: 42,
      completedTurns: 300,
      averageTurnDurationMs: 60_000,
    }],
    totals: {
      completedGames: 125,
      averageGameDurationMs: 86_400_000,
    },
  });

  assert.deepEqual(summary.completedGames, []);
  assert.deepEqual(summary.playerStats, [{
    username: "Jill",
    gamesPlayed: 125,
    wins: 42,
    completedTurns: 300,
    averageTurnDurationMs: 60_000,
  }]);
  assert.deepEqual(summary.totals, {
    completedGames: 125,
    averageGameDurationMs: 86_400_000,
  });
  assert.doesNotMatch(JSON.stringify(summary), /private-user-id/);
});

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
import { addServerNames } from "./public-games.js";

test("public API responses allow anonymous cross-origin reads without credentials", async () => {
  const response = publicJsonResponse({ status: "healthy" });
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, OPTIONS");
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null);
  assert.deepEqual(await response.json(), { status: "healthy" });
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

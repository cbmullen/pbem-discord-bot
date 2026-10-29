import assert from "node:assert/strict";
import test from "node:test";
import {
  methodNotAllowedResponse,
  publicJsonResponse,
  publicOptionsResponse,
} from "./public-api.js";
import healthRoute from "../../api/health.js";
import publicGamesRoute from "../../api/public-games.js";

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

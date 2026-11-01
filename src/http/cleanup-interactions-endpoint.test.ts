import assert from "node:assert/strict";
import test from "node:test";
import cleanupEndpoint from "../../api/cleanup-interactions.js";

test("interaction cleanup rejects unsupported methods", async () => {
  const response = await cleanupEndpoint.fetch(
    new Request("https://bot.example/api/cleanup-interactions", { method: "POST" }),
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});

test("interaction cleanup requires the cron secret", async () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "test-cron-secret";
  try {
    const response = await cleanupEndpoint.fetch(
      new Request("https://bot.example/api/cleanup-interactions"),
    );
    assert.equal(response.status, 401);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test("interaction cleanup reports missing database configuration", async () => {
  const previous = {
    cronSecret: process.env.CRON_SECRET,
    databaseUrl: process.env.DATABASE_URL,
  };
  process.env.CRON_SECRET = "test-cron-secret";
  delete process.env.DATABASE_URL;
  try {
    const response = await cleanupEndpoint.fetch(
      new Request("https://bot.example/api/cleanup-interactions", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );
    assert.equal(response.status, 503);
  } finally {
    if (previous.cronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous.cronSecret;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import remindersEndpoint from "../../api/reminders.js";
import { sendReminder } from "../../api/reminders.js";
import type { DueReminder } from "../database/repository.js";

test("scheduled reminders reject requests without the cron secret", async () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "test-cron-secret";
  try {
    const response = await remindersEndpoint.fetch(
      new Request("https://example.test/api/reminders"),
    );
    assert.equal(response.status, 401);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test("scheduled reminders reject unsupported HTTP methods", async () => {
  const response = await remindersEndpoint.fetch(
    new Request("https://example.test/api/reminders", { method: "POST" }),
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});

test("channel reminder delivery pings only the intended member in the game channel", async () => {
  const previousFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    requestUrl = input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ id: "sent-message" });
  };
  const reminder: DueReminder = {
    gameId: "game-id",
    gameName: "Test game",
    guildId: "guild-id",
    channelId: "channel-id",
    messageId: "board-id",
    userId: "user-id",
    username: "Player",
    pendingSince: "2026-10-29T09:00:00.000Z",
    reminderDays: 2,
    delivery: "channel",
    quietStart: null,
    quietEnd: null,
    utcOffsetMinutes: null,
  };
  try {
    await sendReminder(reminder, "bot-token");
    assert.equal(requestUrl, "https://discord.com/api/v10/channels/channel-id/messages");
    assert.match(String(requestBody?.content), /<@user-id>/);
    assert.deepEqual(requestBody?.allowed_mentions, {
      parse: [],
      users: ["user-id"],
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

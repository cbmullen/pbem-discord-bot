import assert from "node:assert/strict";
import test from "node:test";
import remindersEndpoint from "../../api/reminders.js";

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

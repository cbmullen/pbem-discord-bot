import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { migrateDatabase } from "./migrations.js";
import { openRepository } from "./repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("reminder delivery claims can be retried after failure and stop after sending", async (t) => {
  if (!databaseUrl) {
    t.skip("Set TEST_DATABASE_URL to run the Neon integration test.");
    return;
  }
  const testDatabaseUrl = databaseUrl;
  await migrateDatabase(testDatabaseUrl);
  const repository = openRepository(testDatabaseUrl);
  const suffix = randomUUID();
  const gameId = await repository.createDraft({
    name: `Reminder integration ${suffix}`,
    mode: "consecutive",
    reminderDays: 1,
    guildId: `reminder-test-${suffix}`,
    channelId: `reminder-test-${suffix}`,
    createdBy: `reminder-test-${suffix}`,
  }, "2020-01-01T00:00:00.000Z");

  try {
    const snapshot = await repository.claimDraft(gameId, `reminder-test-${suffix}`);
    assert.ok(snapshot);
    await repository.activateGame(
      gameId,
      [{ userId: `reminder-test-${suffix}`, username: "Integration test" }],
      `reminder-test-${suffix}`,
      "2020-01-01T00:00:00.000Z",
    );

    const reminder = (await repository.listDueReminders(new Date("2020-01-03T00:00:00.000Z")))
      .find((due) => due.gameId === gameId);
    assert.ok(reminder, "active test game should produce a due reminder");

    assert.equal(await repository.claimReminderDelivery(reminder), true);
    assert.equal(await repository.claimReminderDelivery(reminder), false);
    await repository.releaseReminderClaim(reminder);
    assert.equal(await repository.claimReminderDelivery(reminder), true);
    await repository.markReminderSent(reminder);
    assert.equal(await repository.claimReminderDelivery(reminder), false);
  } finally {
    await repository.deleteDraft(gameId);
    await repository.deleteActiveGame(gameId, `reminder-test-${suffix}`);
  }
});

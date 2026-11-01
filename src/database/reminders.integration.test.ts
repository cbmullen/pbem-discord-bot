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
  const pendingSince = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const guildId = `reminder-test-${suffix}`;
  const gameName = `Reminder integration ${suffix}`;
  const gameId = await repository.createDraft({
    name: gameName,
    mode: "consecutive",
    reminderDays: 1,
    guildId,
    channelId: guildId,
    createdBy: guildId,
  }, pendingSince);

  try {
    const snapshot = await repository.claimDraft(gameId, guildId);
    assert.ok(snapshot);
    await repository.activateGame(
      gameId,
      [{ userId: guildId, username: "Integration test" }],
      guildId,
      pendingSince,
    );

    const reminder = (await repository.listDueReminders())
      .find((due) => due.gameId === gameId);
    assert.ok(reminder, "active test game should produce a due reminder");

    await repository.updateActiveGameReminderDays(guildId, gameName, 365);
    assert.equal(
      await repository.claimReminderDelivery(reminder),
      false,
      "claim must reject reminders made ineligible by a threshold change",
    );
    await repository.updateActiveGameReminderDays(guildId, gameName, 1);
    assert.equal(await repository.claimReminderDelivery(reminder), true);
    assert.equal(await repository.claimReminderDelivery(reminder), false);
    await repository.releaseReminderClaim(reminder);
    assert.equal(await repository.claimReminderDelivery(reminder), true);
    await repository.markReminderSent(reminder);
    assert.equal(await repository.claimReminderDelivery(reminder), false);
  } finally {
    await repository.deleteDraft(gameId);
    await repository.deleteActiveGame(gameId, guildId);
  }
});

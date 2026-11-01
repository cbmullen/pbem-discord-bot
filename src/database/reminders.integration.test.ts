import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import test from "node:test";
import { migrateDatabase } from "./migrations.js";
import { getPublicArchiveStatistics, openRepository } from "./repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("interaction deduplication cleanup only removes IDs older than one day", async (t) => {
  if (!databaseUrl) {
    t.skip("Set TEST_DATABASE_URL to run the Neon integration test.");
    return;
  }
  await migrateDatabase(databaseUrl);
  const repository = openRepository(databaseUrl);
  const oldId = `old-interaction-${randomUUID()}`;
  const recentId = `recent-interaction-${randomUUID()}`;
  const sql = neon(databaseUrl);

  try {
    assert.equal(await repository.claimInteraction(oldId), true);
    assert.equal(await repository.claimInteraction(recentId), true);
    await sql`
      UPDATE pbem_processed_interactions
      SET created_at = NOW() - INTERVAL '2 days'
      WHERE interaction_id = ${oldId}
    `;
    assert.equal(await repository.sweepExpiredInteractions(), 1);
    assert.equal(await repository.claimInteraction(oldId), true);
    assert.equal(await repository.claimInteraction(recentId), false);
  } finally {
    await sql`
      DELETE FROM pbem_processed_interactions
      WHERE interaction_id = ANY(${[oldId, recentId]}::text[])
    `;
  }
});

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

test("archive statistics are updated atomically when a game is completed", async (t) => {
  if (!databaseUrl) {
    t.skip("Set TEST_DATABASE_URL to run the Neon integration test.");
    return;
  }
  await migrateDatabase(databaseUrl);
  const repository = openRepository(databaseUrl);
  const sql = neon(databaseUrl);
  const suffix = randomUUID();
  const guildId = `archive-test-${suffix}`;
  const userIds = [`archive-test-a-${suffix}`, `archive-test-b-${suffix}`];
  const creatorId = `archive-test-creator-${suffix}`;
  const startedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const completedAt = new Date().toISOString();
  const gameId = await repository.createDraft({
    name: `Archive integration ${suffix}`,
    mode: "consecutive",
    reminderDays: 0,
    guildId,
    channelId: guildId,
    createdBy: creatorId,
  }, startedAt);

  try {
    assert.ok(await repository.claimDraft(gameId, creatorId));
    await repository.activateGame(
      gameId,
      [{
        userId: userIds[0]!,
        username: "Integration A / Integration B",
        notificationUserIds: userIds,
        notificationUsernames: ["Integration A", "Integration B"],
      }],
      `archive-board-${suffix}`,
      startedAt,
    );
    const before = await getPublicArchiveStatistics(databaseUrl);
    assert.ok(await repository.completeGame(
      gameId,
      guildId,
      userIds[0]!,
      creatorId,
      completedAt,
    ));
    const after = await getPublicArchiveStatistics(databaseUrl);
    const durationMs = Date.parse(completedAt) - Date.parse(startedAt);

    assert.equal(after.totals.completedGames, before.totals.completedGames + 1);
    assert.ok(after.totals.averageGameDurationMs !== null);
    assert.ok(Math.abs(
      after.totals.averageGameDurationMs -
      (((before.totals.averageGameDurationMs ?? 0) * before.totals.completedGames + durationMs) /
        after.totals.completedGames),
    ) < 1);
    for (const [index, username] of ["Integration A", "Integration B"].entries()) {
      assert.deepEqual(
        after.playerStats.find((player) => player.username === username),
        {
          userId: userIds[index],
          username,
          gamesPlayed: 1,
          wins: 1,
          completedTurns: 0,
          averageTurnDurationMs: null,
        },
      );
    }
  } finally {
    await repository.deleteDraft(gameId);
    await repository.deleteActiveGame(gameId, guildId);
    await sql`DELETE FROM pbem_game_archive WHERE game_id = ${gameId}`;
    await sql`
      DELETE FROM pbem_public_archive_player_stats
      WHERE user_id = ANY(${userIds}::text[])
    `;
    await sql`
      UPDATE pbem_public_archive_totals
      SET completed_games = (
            SELECT COUNT(*) FROM pbem_game_archive
          ),
          total_game_duration_ms = COALESCE((
            SELECT SUM(GREATEST(
              0,
              EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000
            ))
            FROM pbem_game_archive
          ), 0)
      WHERE id = true
    `;
  }
});

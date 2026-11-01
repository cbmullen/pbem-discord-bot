import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import test from "node:test";
import { handleDiscordRequest } from "../discord/interactions.js";
import { migrateDatabase } from "./migrations.js";
import { getPublicArchiveStatistics, openRepository } from "./repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("public status rate limits are shared and can be swept after expiry", async (t) => {
  if (!databaseUrl) {
    t.skip("Set TEST_DATABASE_URL to run the Neon integration test.");
    return;
  }
  await migrateDatabase(databaseUrl);
  const repository = openRepository(databaseUrl);
  const clientKey = `rate-limit-test-${randomUUID()}`;
  const sql = neon(databaseUrl);

  try {
    assert.equal((await repository.checkPublicApiRateLimit(clientKey, 2)).allowed, true);
    assert.equal((await repository.checkPublicApiRateLimit(clientKey, 2)).allowed, true);
    const limited = await repository.checkPublicApiRateLimit(clientKey, 2);
    assert.equal(limited.allowed, false);
    assert.ok(limited.retryAfterSeconds > 0 && limited.retryAfterSeconds <= 60);
    await sql`
      UPDATE pbem_public_api_rate_limits
      SET window_started_at = NOW() - INTERVAL '2 days'
      WHERE client_key = ${clientKey}
    `;
    assert.equal(await repository.sweepExpiredPublicApiRateLimits(), 1);
  } finally {
    await sql`
      DELETE FROM pbem_public_api_rate_limits
      WHERE client_key = ${clientKey}
    `;
  }
});

test("deleting archived games by server rebuilds lifetime statistics", async (t) => {
  if (!databaseUrl) {
    t.skip("Set TEST_DATABASE_URL to run the Neon integration test.");
    return;
  }
  await migrateDatabase(databaseUrl);
  const repository = openRepository(databaseUrl);
  const suffix = randomUUID();
  const guildId = `archive-delete-test-${suffix}`;
  const otherGuildId = `archive-delete-other-${suffix}`;
  const creatorId = `archive-delete-creator-${suffix}`;
  const userIds = [`archive-delete-a-${suffix}`, `archive-delete-b-${suffix}`, `archive-delete-c-${suffix}`];
  const gameIds: string[] = [];

  async function archiveGame(
    name: string,
    gameGuildId: string,
    players: Array<{
      userId: string;
      username: string;
      notificationUserIds?: string[];
      notificationUsernames?: string[];
    }>,
  ): Promise<string> {
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const gameId = await repository.createDraft({
      name: `${name} ${suffix}`,
      mode: "consecutive",
      reminderDays: 0,
      guildId: gameGuildId,
      channelId: gameGuildId,
      createdBy: creatorId,
    }, createdAt);
    gameIds.push(gameId);
    assert.ok(await repository.claimDraft(gameId, creatorId));
    await repository.activateGame(gameId, players, `archive-delete-board-${gameId}`, createdAt);
    assert.ok(await repository.completeGame(
      gameId,
      gameGuildId,
      players[0]!.userId,
      creatorId,
      new Date().toISOString(),
    ));
    return gameId;
  }

  try {
    const before = await getPublicArchiveStatistics(databaseUrl);
    await archiveGame("Shared winner", guildId, [{
      userId: userIds[0]!,
      username: `Delete A / Delete B ${suffix}`,
      notificationUserIds: [userIds[0]!, userIds[1]!],
      notificationUsernames: [`Delete A ${suffix}`, `Delete B ${suffix}`],
    }]);
    await archiveGame("Server winner", guildId, [
      { userId: userIds[0]!, username: `Delete A ${suffix}` },
      { userId: userIds[2]!, username: `Delete C ${suffix}` },
    ]);
    await archiveGame("Other server winner", otherGuildId, [
      { userId: userIds[0]!, username: `Delete A ${suffix}` },
    ]);

    assert.equal(await repository.deleteArchivedGamesInGuild(guildId, gameIds[0]!), 1);
    const afterOne = await getPublicArchiveStatistics(databaseUrl);
    assert.equal(afterOne.totals.completedGames, before.totals.completedGames + 2);
    assert.equal(afterOne.playerStats.find(({ userId }) => userId === userIds[1]), undefined);
    assert.equal(
      afterOne.playerStats.find(({ userId }) => userId === userIds[0])?.gamesPlayed,
      2,
    );

    assert.equal(await repository.deleteArchivedGamesInGuild(guildId), 1);
    const afterAll = await getPublicArchiveStatistics(databaseUrl);
    assert.equal(afterAll.totals.completedGames, before.totals.completedGames + 1);
    assert.equal(
      afterAll.playerStats.find(({ userId }) => userId === userIds[0])?.gamesPlayed,
      1,
    );
    assert.equal(afterAll.playerStats.find(({ userId }) => userId === userIds[2]), undefined);
    assert.equal((await repository.listArchivedGamesInGuild(otherGuildId)).length, 1);
  } finally {
    await repository.deleteArchivedGamesInGuild(guildId);
    await repository.deleteArchivedGamesInGuild(otherGuildId);
    for (const gameId of gameIds) {
      await repository.deleteDraft(gameId);
      await repository.deleteActiveGame(gameId, guildId);
      await repository.deleteActiveGame(gameId, otherGuildId);
    }
  }
});

test("game and archive cancel buttons update their messages", async (t) => {
  if (!databaseUrl) {
    t.skip("Set TEST_DATABASE_URL to run the Neon integration test.");
    return;
  }
  await migrateDatabase(databaseUrl);
  const sql = neon(databaseUrl);
  const interactionIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const previous = {
    botToken: process.env.DISCORD_BOT_TOKEN,
    applicationId: process.env.DISCORD_APPLICATION_ID,
    publicKey: process.env.DISCORD_PUBLIC_KEY,
    databaseUrl: process.env.DATABASE_URL,
    fetch: globalThis.fetch,
  };
  process.env.DISCORD_BOT_TOKEN = "test-token";
  process.env.DISCORD_APPLICATION_ID = "test-application";
  process.env.DISCORD_PUBLIC_KEY = publicKeyHex;
  process.env.DATABASE_URL = databaseUrl;
  const discordEdits: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;
    if (url.startsWith("https://discord.com/api/v10/webhooks/")) {
      discordEdits.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }
    return previous.fetch(input, init);
  };

  try {
    for (const [index, customId] of [
      "pbem:delete-cancel:game-id",
      "pbem:gameover-cancel:game-id",
      "pbem:delete-all-cancel",
      `pbem:archive-delete-cancel:${randomUUID()}`,
      "pbem:archive-delete-all-cancel",
    ].entries()) {
      const interaction = {
        id: interactionIds[index],
        type: 3,
        application_id: "test-application",
        token: `interaction-token-${index}`,
        guild_id: "guild-id",
        channel_id: "channel-id",
        member: { user: { id: "user-id" } },
        data: { component_type: 2, custom_id: customId },
      };
      const body = Buffer.from(JSON.stringify(interaction));
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = sign(
        null,
        Buffer.concat([Buffer.from(timestamp), body]),
        privateKey,
      ).toString("hex");
      const tasks: Promise<unknown>[] = [];
      const response = await handleDiscordRequest(
        new Request("https://example.test/api/interactions", {
          method: "POST",
          headers: {
            "x-signature-timestamp": timestamp,
            "x-signature-ed25519": signature,
          },
          body,
        }),
        (task) => tasks.push(task),
      );
      assert.deepEqual(await response.json(), { type: 6 });
      await Promise.all(tasks);
    }

    assert.deepEqual(discordEdits, [
      { content: "Game deletion cancelled.", components: [] },
      { content: "Game over cancelled.", components: [] },
      { content: "Bulk deletion cancelled.", components: [] },
      { content: "Archive deletion cancelled.", components: [] },
      { content: "Archive deletion cancelled.", components: [] },
    ]);
  } finally {
    await sql`
      DELETE FROM pbem_processed_interactions
      WHERE interaction_id = ANY(${interactionIds}::text[])
    `;
    globalThis.fetch = previous.fetch;
    if (previous.botToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = previous.botToken;
    if (previous.applicationId === undefined) delete process.env.DISCORD_APPLICATION_ID;
    else process.env.DISCORD_APPLICATION_ID = previous.applicationId;
    if (previous.publicKey === undefined) delete process.env.DISCORD_PUBLIC_KEY;
    else process.env.DISCORD_PUBLIC_KEY = previous.publicKey;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
  }
});

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

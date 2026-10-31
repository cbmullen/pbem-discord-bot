import assert from "node:assert/strict";
import test from "node:test";
import { buildGameStatusEmbed } from "./game-status.js";
import type { GameSnapshot } from "../game/types.js";

test("status embed shows game settings and each player's current status", () => {
  const snapshot: GameSnapshot = {
    game: {
      id: "game-id",
      name: "Test game",
      mode: "both",
      activeMode: "simultaneous",
      reminderDays: 2,
      guildId: "guild-id",
      channelId: "channel-id",
      messageId: "message-id",
      createdBy: "creator-id",
      createdAt: "2026-10-29T13:06:00.000Z",
      status: "active",
    },
    players: [
      {
        userId: "done-user",
        username: "Done player",
        position: 0,
        status: "done",
        pendingSince: null,
        lastUpdatedAt: "2026-10-29T13:06:00.000Z",
      },
      {
        userId: "pending-user",
        username: "Pending player",
        position: 1,
        status: "pending",
        pendingSince: "2026-10-29T10:00:00.000Z",
        lastUpdatedAt: "2026-10-29T10:00:00.000Z",
      },
    ],
  };

  const embed = buildGameStatusEmbed(snapshot);
  assert.equal(embed.title, "Test game");
  assert.deepEqual(embed.fields, [
    { name: "Players", value: "2", inline: true },
    { name: "Pending", value: "1", inline: true },
    { name: "Started", value: "<t:1793279160:f>", inline: true },
    { name: "Turn mode", value: "simultaneous (switchable)", inline: true },
    { name: "Automated reminders", value: "After 2 days pending", inline: true },
  ]);
  assert.equal(
    embed.description,
    "• Done player — Done\n• Pending player — Pending · <t:1793268000:R>",
  );
});

test("status embed shows away players and that the game is paused", () => {
  const snapshot: GameSnapshot = {
    game: {
      id: "game-id",
      name: "Test game",
      mode: "consecutive",
      activeMode: "consecutive",
      reminderDays: 1,
      guildId: "guild-id",
      channelId: "channel-id",
      messageId: "message-id",
      createdBy: "creator-id",
      createdAt: "2026-10-29T13:06:00.000Z",
      status: "active",
    },
    players: [
      {
        userId: "away-user",
        username: "Away player",
        position: 0,
        status: "pending",
        pendingSince: "2026-10-29T10:00:00.000Z",
        lastUpdatedAt: "2026-10-29T10:00:00.000Z",
      },
    ],
    away: { "away-user": { until: null } },
  };
  const embed = buildGameStatusEmbed(snapshot);
  assert.ok(embed.fields.some((field) => field.name === "Paused" && /Reminders are off/.test(field.value)));
  assert.match(embed.description, /Away player — Pending · <t:1793268000:R> · Away \(no return date\)/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { getDueReminderPlayers } from "./reminders.js";
import type { Player } from "./types.js";

const players: Player[] = [
  {
    userId: "due",
    username: "Due",
    position: 0,
    status: "pending",
    pendingSince: "2026-10-27T09:00:00.000Z",
    lastUpdatedAt: "2026-10-27T09:00:00.000Z",
  },
  {
    userId: "not-due",
    username: "Not due",
    position: 1,
    status: "pending",
    pendingSince: "2026-10-28T09:00:00.000Z",
    lastUpdatedAt: "2026-10-28T09:00:00.000Z",
  },
  {
    userId: "done",
    username: "Done",
    position: 2,
    status: "done",
    pendingSince: null,
    lastUpdatedAt: "2026-10-27T09:00:00.000Z",
  },
];

test("selects only pending players beyond the reminder threshold", () => {
  assert.deepEqual(
    getDueReminderPlayers(players, 2, new Date("2026-10-29T09:00:00.000Z"))
      .map((player) => player.userId),
    ["due"],
  );
});

test("zero reminder days disables automated reminders", () => {
  assert.deepEqual(
    getDueReminderPlayers(players, 0, new Date("2026-10-29T09:00:00.000Z")),
    [],
  );
});

test("a player exactly at the day threshold is eligible", () => {
  assert.deepEqual(
    getDueReminderPlayers(players, 2, new Date("2026-10-29T09:00:00.000Z"))
      .map((player) => player.userId),
    ["due"],
  );
});

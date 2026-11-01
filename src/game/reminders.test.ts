import assert from "node:assert/strict";
import test from "node:test";
import {
  getDueReminderPlayers,
  isInQuietHours,
  parseClockTime,
  parseUtcOffset,
  shouldSendScheduledReminder,
} from "./reminders.js";
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

test("quiet hours use the configured UTC offset and include overnight ranges", () => {
  const quietHours = {
    start: parseClockTime("22:00")!,
    end: parseClockTime("07:00")!,
    utcOffsetMinutes: parseUtcOffset("-07:00")!,
  };
  assert.equal(isInQuietHours(new Date("2026-11-01T06:00:00.000Z"), quietHours), true);
  assert.equal(isInQuietHours(new Date("2026-11-01T15:00:00.000Z"), quietHours), false);
});

test("quiet-hour time and offset inputs reject invalid values", () => {
  assert.equal(parseClockTime("24:00"), undefined);
  assert.equal(parseClockTime("9:30"), undefined);
  assert.equal(parseUtcOffset("+14:15"), undefined);
  assert.equal(parseUtcOffset("-12:15"), undefined);
  assert.equal(parseUtcOffset("+05:45"), 345);
});

test("scheduled reminders honor none and defer delivery during quiet hours", () => {
  const now = new Date("2026-11-01T06:00:00.000Z");
  assert.equal(shouldSendScheduledReminder("none", null, null, null, now), false);
  assert.equal(shouldSendScheduledReminder("dm", 22 * 60, 7 * 60, -420, now), false);
  assert.equal(shouldSendScheduledReminder("channel", 22 * 60, 7 * 60, -420, new Date("2026-11-01T15:00:00.000Z")), true);
});

test("no reminders go out while anyone in the game is away", () => {
  const now = new Date("2026-10-29T09:00:00.000Z");
  assert.deepEqual(
    getDueReminderPlayers(players, 2, now, { done: { until: null } }),
    [],
    "even the overdue player is held back",
  );
  assert.deepEqual(
    getDueReminderPlayers(players, 2, now, { "someone-else": { until: null } })
      .map((player) => player.userId),
    ["due"],
    "away players from other games do not matter",
  );
  assert.deepEqual(
    getDueReminderPlayers(players, 2, now, { done: { until: "2026-10-28T00:00:00.000Z" } })
      .map((player) => player.userId),
    ["due"],
    "reminders resume once the return date passes",
  );
});

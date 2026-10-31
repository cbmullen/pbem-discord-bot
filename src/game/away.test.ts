import assert from "node:assert/strict";
import test from "node:test";
import {
  activeAway,
  awayLabel,
  formatAwayDate,
  isGamePaused,
  parseAwayUntil,
} from "./away.js";
import type { Player } from "./types.js";

const now = new Date("2026-10-31T12:00:00.000Z");

function player(userId: string): Player {
  return {
    userId,
    username: userId,
    position: 0,
    status: "pending",
    pendingSince: "2026-10-30T00:00:00.000Z",
    lastUpdatedAt: "2026-10-30T00:00:00.000Z",
  };
}

test("a future YYYY-MM-DD date becomes the start of that day in UTC", () => {
  assert.deepEqual(parseAwayUntil("2026-11-10", now), {
    ok: true,
    until: "2026-11-10T00:00:00.000Z",
  });
  assert.deepEqual(parseAwayUntil(" 2026-11-10 ", now), {
    ok: true,
    until: "2026-11-10T00:00:00.000Z",
  });
});

test("malformed, impossible, past and far-future dates are rejected", () => {
  for (const input of ["10/11/2026", "2026-1-10", "tomorrow", "", "2026-02-30", "2026-13-01"]) {
    assert.equal(parseAwayUntil(input, now).ok, false, input);
  }
  assert.equal(parseAwayUntil("2026-10-31", now).ok, false, "earlier today is already past");
  assert.equal(parseAwayUntil("2026-10-01", now).ok, false);
  assert.equal(parseAwayUntil("2028-01-01", now).ok, false);
  assert.equal(parseAwayUntil("2027-10-30", now).ok, true);
});

test("away records without a date last until cleared; dated ones expire", () => {
  const away = {
    open: { until: null },
    future: { until: "2026-11-10T00:00:00.000Z" },
    past: { until: "2026-10-30T00:00:00.000Z" },
  };
  assert.deepEqual(Object.keys(activeAway(away, now)).sort(), ["future", "open"]);
  assert.deepEqual(activeAway(undefined, now), {});
});

test("a game is paused while any of its players is away", () => {
  const players = [player("a"), player("b")];
  assert.equal(isGamePaused(players, undefined, now), false);
  assert.equal(isGamePaused(players, { c: { until: null } }, now), false, "away but not in this game");
  assert.equal(isGamePaused(players, { b: { until: null } }, now), true);
  assert.equal(
    isGamePaused(players, { b: { until: "2026-10-30T00:00:00.000Z" } }, now),
    false,
    "an expired return date no longer pauses the game",
  );
});

test("labels show the return date, adding the year only when it differs", () => {
  assert.equal(formatAwayDate("2026-11-10T00:00:00.000Z", now), "10 Nov");
  assert.equal(formatAwayDate("2027-01-05T00:00:00.000Z", now), "5 Jan 2027");
  assert.equal(awayLabel("2026-11-10T00:00:00.000Z", now), "Away until 10 Nov");
  assert.equal(awayLabel(null, now), "Away (no return date)");
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildGameBoard } from "./game-board.js";
import type { GameSnapshot, Player } from "../game/types.js";

function makeSnapshot(
  mode: "consecutive" | "both",
  playerCount: number,
  activeMode: GameSnapshot["game"]["activeMode"] = "consecutive",
): GameSnapshot {
  const players: Player[] = Array.from({ length: playerCount }, (_, position) => ({
    userId: `user-${position}`,
    username: `Player ${position}`,
    position,
    status: position === 0 ? "pending" : "done",
    pendingSince: position === 0 ? "2026-10-29T00:00:00.000Z" : null,
    lastUpdatedAt: "2026-10-29T00:00:00.000Z",
  }));
  return {
    game: {
      id: "game-id",
      name: "Test",
      mode,
      activeMode,
      reminderDays: 0,
      guildId: "guild-id",
      channelId: "channel-id",
      messageId: null,
      createdBy: "creator-id",
      createdAt: "2026-10-29T00:00:00.000Z",
      status: "active",
    },
    players,
  };
}

test("board components fit Discord's five action rows at maximum roster sizes", () => {
  const consecutive = buildGameBoard(makeSnapshot("consecutive", 25));
  const both = buildGameBoard(makeSnapshot("both", 24));
  assert.match(consecutive.content, /^\*\*Playing: Test\*\*\nPending:/);
  assert.doesNotMatch(consecutive.content, /PBEM:|consecutive/);
  assert.equal(consecutive.components.at(0)?.components.at(0)?.style, 1);
  assert.equal(consecutive.components.at(0)?.components.at(1)?.style, 3);
  assert.equal(consecutive.components.at(0)?.components.at(0)?.disabled, true);
  assert.equal(consecutive.components.at(0)?.components.at(1)?.disabled, false);
  assert.equal(consecutive.components?.length, 5);
  assert.equal(both.components?.length, 5);
  assert.equal(
    both.components.reduce((total, row) => total + row.components.length, 0),
    25,
  );
});

test("pending player buttons remain clickable in simultaneous mode", () => {
  const simultaneous = buildGameBoard(makeSnapshot("both", 2, "simultaneous"));
  assert.equal(simultaneous.components.at(0)?.components.at(0)?.disabled, false);
});

test("away status is shown beneath the game title without changing player buttons", () => {
  const now = new Date("2026-10-31T12:00:00.000Z");
  const snapshot = {
    ...makeSnapshot("consecutive", 3),
    away: { "user-0": { until: "2026-11-10T00:00:00.000Z" }, "user-2": { until: null } },
  };
  const board = buildGameBoard(snapshot, false, now);
  assert.match(board.content, /^\*\*Playing: Test\*\*\n\n⏸️ \*\*Away\*\*/);
  assert.match(board.content, /<@user-0> — Away until 10 Nov/);
  assert.match(board.content, /<@user-2> — Away \(no return date\)/);
  assert.match(board.content, /reminders are disabled until everyone is back/);
  assert.equal(board.components[0]!.components[0]!.custom_id, "pbem:player:game-id:user-0");
  assert.equal(board.components[0]!.components[0]!.label, "Player 0 - pending");
  assert.equal(board.components[0]!.components[0]!.style, 1);
});

test("the board shows no away section after an away record expires", () => {
  const now = new Date("2026-10-31T12:00:00.000Z");
  const base = makeSnapshot("consecutive", 2);
  const expired = buildGameBoard(
    { ...base, away: { "user-1": { until: "2026-10-30T00:00:00.000Z" } } },
    false,
    now,
  );
  assert.doesNotMatch(expired.content, /Away|Paused/);
});

test("away players never change who is mentioned for pending turns", () => {
  const snapshot = {
    ...makeSnapshot("both", 2, "simultaneous"),
    away: { "user-1": { until: null } },
  };
  snapshot.players[1]!.status = "pending";
  const board = buildGameBoard(snapshot, true);
  assert.deepEqual(board.allowed_mentions.users, ["user-0", "user-1"]);
});

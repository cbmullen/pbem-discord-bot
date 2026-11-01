import assert from "node:assert/strict";
import test from "node:test";
import type { GameSnapshot, Player } from "../game/types.js";
import {
  buildNoDbGameBoard,
  readNoDbBoardState,
  updateNoDbGameBoard,
} from "./nodb-game-board.js";

function snapshot(mode: GameSnapshot["game"]["mode"] = "both"): GameSnapshot {
  const players: Player[] = [
    {
      userId: "user-1",
      username: "Player 1",
      position: 0,
      status: "pending",
      pendingSince: "2026-10-30T09:00:00.000Z",
      lastUpdatedAt: "2026-10-30T09:00:00.000Z",
    },
    {
      userId: "user-2",
      username: "Player 2",
      position: 1,
      status: "done",
      pendingSince: null,
      lastUpdatedAt: "2026-10-30T09:00:00.000Z",
    },
  ];
  return {
    game: {
      id: "12345678-1234-1234-1234-123456789012",
      name: "No DB Game",
      mode,
      activeMode: mode === "both" ? "consecutive" : mode,
      reminderDays: 0,
      guildId: "guild-id",
      channelId: "channel-id",
      messageId: null,
      createdBy: "creator-id",
      createdAt: "2026-10-30T09:00:00.000Z",
      status: "active",
    },
    players,
  };
}

test("no-database board keeps status in buttons and announces new pending players", () => {
  const board = buildNoDbGameBoard(snapshot());
  const state = readNoDbBoardState(board);
  const playerButton = board.components[0]!.components[1]!;
  const updated = updateNoDbGameBoard(
    board,
    playerButton.custom_id,
    new Date("2026-10-31T12:00:00.000Z"),
  );
  const next = readNoDbBoardState(updated);

  assert.match(board.content, /only saved copy/);
  assert.equal(state.mode, "both");
  assert.equal(state.activeMode, "consecutive");
  assert.equal(next.activeMode, "consecutive");
  assert.deepEqual(next.players.map((player) => player.status), ["done", "pending"]);
  assert.equal(next.players[1]?.pendingSince, "2026-10-31T12:00:00.000Z");
  assert.deepEqual(updated.newlyPending, ["user-2"]);
  assert.ok(updated.components
    .flatMap((row) => row.components ?? [])
    .every((button) => (button.custom_id?.length ?? 0) <= 100));
  assert.throws(
    () => updateNoDbGameBoard(updated, playerButton.custom_id),
    /changed; click a current button/,
  );
});

test("no-database mode switching uses the existing turn transition rules", () => {
  const board = buildNoDbGameBoard(snapshot());
  const modeButton = board.components[0]!.components.at(-1)!;
  const updated = updateNoDbGameBoard(board, modeButton.custom_id);
  const state = readNoDbBoardState(updated);

  assert.equal(state.activeMode, "simultaneous");
  assert.deepEqual(state.players.map((player) => player.status), ["pending", "pending"]);
  assert.deepEqual(updated.newlyPending, ["user-2"]);
});

test("no-database boards support modes without a mode switch button", () => {
  const board = buildNoDbGameBoard(snapshot("simultaneous"));
  const state = readNoDbBoardState(board);
  assert.equal(state.mode, "simultaneous");
  assert.equal(state.activeMode, "simultaneous");
  assert.equal(state.revision, 0);
});

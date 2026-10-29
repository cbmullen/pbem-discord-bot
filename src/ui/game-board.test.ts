import assert from "node:assert/strict";
import test from "node:test";
import { buildGameBoard } from "./game-board.js";
import type { GameSnapshot, Player } from "../game/types.js";

function makeSnapshot(mode: "consecutive" | "both", playerCount: number): GameSnapshot {
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
      activeMode: "consecutive",
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
  assert.match(consecutive.content, /^\*\*Test\*\*\nPending:/);
  assert.doesNotMatch(consecutive.content, /PBEM:|consecutive/);
  assert.equal(consecutive.components.at(0)?.components.at(0)?.style, 1);
  assert.equal(consecutive.components.at(0)?.components.at(1)?.style, 3);
  assert.equal(consecutive.components?.length, 5);
  assert.equal(both.components?.length, 5);
  assert.equal(
    both.components.reduce((total, row) => total + row.components.length, 0),
    25,
  );
});

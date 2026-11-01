import assert from "node:assert/strict";
import test from "node:test";
import type { Player } from "./types.js";
import { addPlayers, PlayerRosterError, removePlayers } from "./players.js";

const now = "2026-11-01T09:00:00.000Z";
const players: Player[] = [
  {
    userId: "user-1",
    username: "Player 1",
    position: 0,
    status: "pending",
    pendingSince: now,
    lastUpdatedAt: now,
  },
  {
    userId: "user-2",
    username: "Player 2",
    position: 1,
    status: "done",
    pendingSince: null,
    lastUpdatedAt: now,
  },
];

test("added players join the current turn state and append to the roster", () => {
  const added = addPlayers(
    { mode: "both", activeMode: "simultaneous", players },
    [{ userId: "user-3", username: "Player 3" }],
    now,
  );
  assert.deepEqual(added.map((player) => [player.position, player.status]), [
    [0, "pending"],
    [1, "done"],
    [2, "pending"],
  ]);
  assert.equal(added[2]?.pendingSince, now);
});

test("consecutive additions join at the end without changing the current turn", () => {
  const added = addPlayers(
    { mode: "consecutive", activeMode: "consecutive", players },
    [{ userId: "user-3", username: "Player 3" }],
    now,
  );
  assert.deepEqual(added.map((player) => player.status), ["pending", "done", "done"]);
});

test("adding existing players or exceeding the game limit is rejected", () => {
  assert.throws(
    () => addPlayers(
      { mode: "consecutive", activeMode: "consecutive", players },
      [{ userId: "user-1", username: "Player 1" }],
      now,
    ),
    PlayerRosterError,
  );
  assert.throws(
    () => addPlayers(
      {
        mode: "both",
        activeMode: "simultaneous",
        players: Array.from({ length: 24 }, (_, position) => ({
          ...players[0]!,
          userId: `user-${position}`,
          position,
        })),
      },
      [{ userId: "extra", username: "Extra" }],
      now,
    ),
    /supports up to 24 players/,
  );
});

test("removing the current consecutive player advances the pending turn", () => {
  const removed = removePlayers(
    { mode: "consecutive", activeMode: "consecutive", players },
    ["user-1"],
    now,
  );
  assert.deepEqual(removed.map((player) => [player.userId, player.position, player.status]), [
    ["user-2", 0, "pending"],
  ]);
  assert.equal(removed[0]?.pendingSince, now);
});

test("removing the last simultaneous pending player starts the next round", () => {
  const removed = removePlayers(
    { mode: "simultaneous", activeMode: "simultaneous", players },
    ["user-1"],
    now,
  );
  assert.deepEqual(removed.map((player) => player.status), ["pending"]);
  assert.equal(removed[0]?.pendingSince, now);
});

test("only existing players can be removed and a game cannot become empty", () => {
  assert.throws(
    () => removePlayers(
      { mode: "both", activeMode: "consecutive", players },
      ["user-3"],
      now,
    ),
    /Only players in this game/,
  );
  assert.throws(
    () => removePlayers(
      { mode: "both", activeMode: "consecutive", players: [players[0]!] },
      ["user-1"],
      now,
    ),
    /at least one player/,
  );
});

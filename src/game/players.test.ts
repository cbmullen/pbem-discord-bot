import assert from "node:assert/strict";
import test from "node:test";
import type { Player } from "./types.js";
import { addPlayers, addTeam, PlayerRosterError, removePlayers } from "./players.js";

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

test("a shared team is one player with both members in the notification list", () => {
  const team = addTeam(
    { mode: "both", activeMode: "simultaneous", players },
    [
      { userId: "user-3", username: "Jill" },
      { userId: "user-4", username: "Jack" },
    ],
    now,
  );
  assert.equal(team.length, 3);
  assert.deepEqual(
    [team[2]?.userId, team[2]?.username, team[2]?.notificationUserIds, team[2]?.status],
    ["user-3", "Jill / Jack", ["user-3", "user-4"], "pending"],
  );
});

test("teams can be added to a game created with no players", () => {
  const firstTeam = addTeam(
    { mode: "consecutive", activeMode: "consecutive", players: [] },
    [
      { userId: "user-3", username: "Jill" },
      { userId: "user-4", username: "Jack" },
    ],
    now,
  );
  const teams = addTeam(
    { mode: "consecutive", activeMode: "consecutive", players: firstTeam },
    [
      { userId: "user-5", username: "Rose" },
      { userId: "user-6", username: "Tom" },
    ],
    now,
  );
  assert.deepEqual(teams.map((team) => team.notificationUserIds), [
    ["user-3", "user-4"],
    ["user-5", "user-6"],
  ]);
  assert.deepEqual(teams.map((team) => team.status), ["pending", "done"]);
});

test("the first player added to an empty consecutive game starts pending", () => {
  const added = addPlayers(
    { mode: "consecutive", activeMode: "consecutive", players: [] },
    [{ userId: "user-1", username: "Player 1" }],
    now,
  );
  assert.equal(added[0]?.status, "pending");
});

test("shared teams require multiple new members and use one roster slot", () => {
  assert.throws(
    () => addTeam(
      { mode: "consecutive", activeMode: "consecutive", players },
      [{ userId: "user-3", username: "Jill" }],
      now,
    ),
    /at least two/,
  );
  assert.throws(
    () => addTeam(
      { mode: "consecutive", activeMode: "consecutive", players },
      Array.from({ length: 9 }, (_, index) => ({
        userId: `member-${index}`,
        username: `Member ${index}`,
      })),
      now,
    ),
    /at most eight/,
  );
  assert.throws(
    () => addTeam(
      { mode: "consecutive", activeMode: "consecutive", players },
      [
        { userId: "user-3", username: "Jill" },
        { userId: "user-1", username: "Player 1" },
      ],
      now,
    ),
    /already in this game/,
  );
});

test("removing a shared team removes one turn entry", () => {
  const team = addTeam(
    { mode: "consecutive", activeMode: "consecutive", players },
    [
      { userId: "user-3", username: "Jill" },
      { userId: "user-4", username: "Jack" },
    ],
    now,
  );
  const remaining = removePlayers(
    { mode: "consecutive", activeMode: "consecutive", players: team },
    ["user-3"],
    now,
  );
  assert.deepEqual(remaining.map((player) => player.userId), ["user-1", "user-2"]);
  assert.equal(remaining.some((player) => player.notificationUserIds?.includes("user-4")), false);
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

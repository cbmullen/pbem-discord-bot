import assert from "node:assert/strict";
import test from "node:test";
import { createInitialPlayers, selectPlayer, switchMode } from "./turns.js";

const now = "2026-10-29T00:00:00.000Z";
const selected = [
  { userId: "one", username: "One" },
  { userId: "two", username: "Two" },
  { userId: "three", username: "Three" },
];

test("consecutive games start with only the first player pending", () => {
  const players = createInitialPlayers(selected, "consecutive", now);
  assert.deepEqual(
    players.map((player) => player.status),
    ["pending", "done", "done"],
  );
});

test("simultaneous games reset everyone to pending when the last player finishes", () => {
  const initial = createInitialPlayers(selected, "simultaneous", now);
  const afterOne = selectPlayer(
    { mode: "simultaneous", activeMode: "simultaneous", players: initial },
    "one",
    "2026-10-29T00:01:00.000Z",
  );
  assert.deepEqual(
    afterOne.state.players.map((player) => player.status),
    ["done", "pending", "pending"],
  );
  const afterTwo = selectPlayer(
    afterOne.state,
    "two",
    "2026-10-29T00:02:00.000Z",
  );
  const afterThree = selectPlayer(
    afterTwo.state,
    "three",
    "2026-10-29T00:03:00.000Z",
  );
  assert.equal(afterThree.eventType, "cycle_reset");
  assert.deepEqual(
    afterThree.state.players.map((player) => player.status),
    ["pending", "pending", "pending"],
  );
});

test("both games start consecutive and switching modes applies defined transitions", () => {
  const initial = createInitialPlayers(selected, "consecutive", now);
  const state = { mode: "both" as const, activeMode: "consecutive" as const, players: initial };
  const simultaneous = switchMode(state, "2026-10-29T00:01:00.000Z");
  assert.equal(simultaneous.state.activeMode, "simultaneous");
  assert.deepEqual(
    simultaneous.state.players.map((player) => player.status),
    ["pending", "pending", "pending"],
  );
  const consecutive = switchMode(simultaneous.state, "2026-10-29T00:02:00.000Z");
  assert.equal(consecutive.state.activeMode, "consecutive");
  assert.deepEqual(
    consecutive.state.players.map((player) => player.status),
    ["pending", "done", "done"],
  );
});


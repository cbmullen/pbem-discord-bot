import assert from "node:assert/strict";
import test from "node:test";
import { groupAwayRows, isGameNameConstraintViolation } from "./repository.js";

test("identifies uniqueness conflicts for game-name indexes", () => {
  assert.equal(
    isGameNameConstraintViolation({
      code: "23505",
      constraint: "pbem_unique_game_name_per_server",
    }),
    true,
  );
  assert.equal(
    isGameNameConstraintViolation({
      code: "23505",
      constraint: "pbem_unique_game_name_per_channel",
    }),
    true,
  );
});

test("does not mistake unrelated database errors for duplicate game names", () => {
  assert.equal(
    isGameNameConstraintViolation({
      code: "23505",
      constraint: "some_other_unique_index",
    }),
    false,
  );
  assert.equal(
    isGameNameConstraintViolation({
      code: "23503",
      constraint: "pbem_unique_game_name_per_server",
    }),
    false,
  );
  assert.equal(isGameNameConstraintViolation(new Error("database unavailable")), false);
});

test("away rows are grouped per server and accept Date or string return times", () => {
  const grouped = groupAwayRows([
    { guild_id: "g1", user_id: "a", until: null },
    { guild_id: "g1", user_id: "b", until: new Date("2026-11-10T00:00:00.000Z") },
    { guild_id: "g2", user_id: "a", until: "2026-12-01T00:00:00.000Z" },
  ]);
  assert.deepEqual(grouped.get("g1"), {
    a: { until: null },
    b: { until: "2026-11-10T00:00:00.000Z" },
  });
  assert.deepEqual(grouped.get("g2"), { a: { until: "2026-12-01T00:00:00.000Z" } });
});

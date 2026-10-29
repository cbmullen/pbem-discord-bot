import assert from "node:assert/strict";
import test from "node:test";
import { isGameNameConstraintViolation } from "./repository.js";

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

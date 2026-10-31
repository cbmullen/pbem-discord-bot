import assert from "node:assert/strict";
import test from "node:test";
import { commands } from "./definitions.js";

interface CommandOption {
  name: string;
  description: string;
  type: number;
  required?: boolean;
}

function optionsOf(command: (typeof commands)[number]): CommandOption[] {
  return ("options" in command ? command.options : []) as CommandOption[];
}

test("every command and option satisfies Discord's naming and length rules", () => {
  const names = new Set<string>();
  for (const command of commands) {
    assert.match(command.name, /^[a-z0-9-]{1,32}$/);
    assert.ok(!names.has(command.name), `duplicate command ${command.name}`);
    names.add(command.name);
    assert.ok(command.description.length >= 1 && command.description.length <= 100, command.name);
    for (const option of optionsOf(command)) {
      assert.match(option.name, /^[a-z0-9-]{1,32}$/);
      assert.ok(option.description.length >= 1 && option.description.length <= 100, option.name);
    }
  }
});

test("/pbem-away and /pbem-back take an optional player, and away an optional date", () => {
  const away = commands.find((command) => command.name === "pbem-away");
  const back = commands.find((command) => command.name === "pbem-back");
  assert.ok(away && back);
  assert.deepEqual(
    optionsOf(away).map((option) => [option.name, option.type, option.required]),
    [["player", 6, false], ["until", 3, false]],
  );
  assert.deepEqual(
    optionsOf(back).map((option) => [option.name, option.type, option.required]),
    [["player", 6, false]],
  );
});

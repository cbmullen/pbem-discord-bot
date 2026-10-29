import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  activeGameChoices,
  handleDiscordRequest,
  splitMessage,
  verifyDiscordSignature,
} from "./interactions.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
const publicKeyHex = publicKeyDer.subarray(-32).toString("hex");

test("game-list messages split at line boundaries within Discord limits", () => {
  const chunks = splitMessage("one\ntwo\nthree", 7);
  assert.deepEqual(chunks, ["one\ntwo", "three"]);
  assert.ok(chunks.every((chunk) => chunk.length <= 7));
});

test("active game autocomplete filters games and caps choices at 25", () => {
  const games = Array.from({ length: 30 }, (_, index) => ({
    name: `Game ${index + 1}`,
  }));
  assert.deepEqual(activeGameChoices(games, " GAME 2 "), [
    { name: "Game 2", value: "Game 2" },
    { name: "Game 20", value: "Game 20" },
    { name: "Game 21", value: "Game 21" },
    { name: "Game 22", value: "Game 22" },
    { name: "Game 23", value: "Game 23" },
    { name: "Game 24", value: "Game 24" },
    { name: "Game 25", value: "Game 25" },
    { name: "Game 26", value: "Game 26" },
    { name: "Game 27", value: "Game 27" },
    { name: "Game 28", value: "Game 28" },
    { name: "Game 29", value: "Game 29" },
  ]);
  assert.equal(activeGameChoices(games, "").length, 25);
});

test("game-list message splitting rejects entries longer than its limit", () => {
  assert.throws(() => splitMessage("12345678", 7), /exceeds the Discord message limit/);
});

function signedRequest(body: Buffer, timestamp = Math.floor(Date.now() / 1000).toString()): Request {
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(timestamp), body]),
    privateKey,
  ).toString("hex");
  return new Request("https://example.test/api/interactions", {
    method: "POST",
    headers: {
      "x-signature-timestamp": timestamp,
      "x-signature-ed25519": signature,
    },
    body: body.toString(),
  });
}

test("Discord Ed25519 signatures are verified against the exact raw body", () => {
  const body = Buffer.from('{"type":1}');
  const request = signedRequest(body);
  assert.equal(
    verifyDiscordSignature(
      body,
      request.headers.get("x-signature-timestamp"),
      request.headers.get("x-signature-ed25519"),
      publicKeyHex,
    ),
    true,
  );
  assert.equal(
    verifyDiscordSignature(
      Buffer.from('{"type":2}'),
      request.headers.get("x-signature-timestamp"),
      request.headers.get("x-signature-ed25519"),
      publicKeyHex,
    ),
    false,
  );
});

test("Discord Ed25519 signatures outside the five-minute window are rejected", () => {
  const body = Buffer.from('{"type":1}');
  const timestamp = (Math.floor(Date.now() / 1000) - 301).toString();
  const request = signedRequest(body, timestamp);

  assert.equal(
    verifyDiscordSignature(
      body,
      request.headers.get("x-signature-timestamp"),
      request.headers.get("x-signature-ed25519"),
      publicKeyHex,
    ),
    false,
  );
});

test("signed Discord ping requests receive the required pong response", async () => {
  const previous = {
    token: process.env.DISCORD_BOT_TOKEN,
    applicationId: process.env.DISCORD_APPLICATION_ID,
    publicKey: process.env.DISCORD_PUBLIC_KEY,
    databaseUrl: process.env.DATABASE_URL,
  };
  process.env.DISCORD_BOT_TOKEN = "test-token";
  process.env.DISCORD_APPLICATION_ID = "test-application";
  process.env.DISCORD_PUBLIC_KEY = publicKeyHex;
  process.env.DATABASE_URL = "postgresql://test:test@localhost/test";
  try {
    const response = await handleDiscordRequest(
      signedRequest(Buffer.from('{"type":1}')),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { type: 1 });
  } finally {
    if (previous.token === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = previous.token;
    if (previous.applicationId === undefined) delete process.env.DISCORD_APPLICATION_ID;
    else process.env.DISCORD_APPLICATION_ID = previous.applicationId;
    if (previous.publicKey === undefined) delete process.env.DISCORD_PUBLIC_KEY;
    else process.env.DISCORD_PUBLIC_KEY = previous.publicKey;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
  }
});

test("invalid Discord signatures are rejected", async () => {
  const body = Buffer.from('{"type":1}');
  const previous = {
    token: process.env.DISCORD_BOT_TOKEN,
    applicationId: process.env.DISCORD_APPLICATION_ID,
    publicKey: process.env.DISCORD_PUBLIC_KEY,
    databaseUrl: process.env.DATABASE_URL,
  };
  process.env.DISCORD_BOT_TOKEN = "test-token";
  process.env.DISCORD_APPLICATION_ID = "test-application";
  process.env.DISCORD_PUBLIC_KEY = publicKeyHex;
  process.env.DATABASE_URL = "postgresql://test:test@localhost/test";
  try {
    const response = await handleDiscordRequest(
      new Request("https://example.test/api/interactions", {
        method: "POST",
        headers: {
          "x-signature-timestamp": "1730000000",
          "x-signature-ed25519": "0".repeat(128),
        },
        body: body.toString(),
      }),
    );
    assert.equal(response.status, 401);
  } finally {
    if (previous.token === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = previous.token;
    if (previous.applicationId === undefined) delete process.env.DISCORD_APPLICATION_ID;
    else process.env.DISCORD_APPLICATION_ID = previous.applicationId;
    if (previous.publicKey === undefined) delete process.env.DISCORD_PUBLIC_KEY;
    else process.env.DISCORD_PUBLIC_KEY = previous.publicKey;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
  }
});

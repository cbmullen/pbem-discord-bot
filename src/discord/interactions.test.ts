import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  handleDiscordRequest,
  verifyDiscordSignature,
} from "./interactions.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
const publicKeyHex = publicKeyDer.subarray(-32).toString("hex");

function signedRequest(body: Buffer): Request {
  const timestamp = "1730000000";
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

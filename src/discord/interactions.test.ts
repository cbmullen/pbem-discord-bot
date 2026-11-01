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
  delete process.env.DATABASE_URL;
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

test("/pbem-nodb creates and updates a board without making a database request", async () => {
  const previous = {
    token: process.env.DISCORD_BOT_TOKEN,
    applicationId: process.env.DISCORD_APPLICATION_ID,
    publicKey: process.env.DISCORD_PUBLIC_KEY,
    databaseUrl: process.env.DATABASE_URL,
    fetch: globalThis.fetch,
    consoleError: console.error,
  };
  process.env.DISCORD_BOT_TOKEN = "test-token";
  process.env.DISCORD_APPLICATION_ID = "test-application";
  process.env.DISCORD_PUBLIC_KEY = publicKeyHex;
  process.env.DATABASE_URL = "postgresql://test:test@localhost/test";
  delete process.env.DATABASE_URL;
  console.error = () => {};
  let boardMessage: Record<string, unknown> | undefined;
  const postedBoards: Record<string, unknown>[] = [];
  const messageOperations: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;
    if (!url.startsWith("https://discord.com/api/v10/")) {
      throw new Error("Unexpected non-Discord request");
    }
    if (url.includes("/webhooks/")) return new Response(null, { status: 204 });
    if (init?.method === "GET" && url.endsWith("/messages/board-id")) {
      return Response.json({ id: "board-id", ...boardMessage });
    }
    if (init?.method === "DELETE" && url.endsWith("/messages/board-id")) {
      messageOperations.push("delete-old");
      return new Response(null, { status: 204 });
    }
    if (init?.method === "POST" && url.endsWith("/channels/channel-id/messages")) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (typeof body.content === "string" && body.content.startsWith("**Playing:")) {
        postedBoards.push(body);
        messageOperations.push("post-board");
        const id = postedBoards.length === 1 ? "board-id" : "updated-board-id";
        boardMessage = { id, ...body };
        return Response.json({ id });
      }
      throw new Error("A button click should not post a separate turn update");
    }
    throw new Error(`Unexpected Discord request: ${init?.method} ${url}`);
  };

  async function run(
    interaction: Record<string, unknown>,
  ): Promise<{ callback: unknown; tasks: Promise<unknown>[] }> {
    const tasks: Promise<unknown>[] = [];
    const response = await handleDiscordRequest(
      signedRequest(Buffer.from(JSON.stringify(interaction))),
      (task) => tasks.push(task),
    );
    const callback = await response.json();
    await Promise.all(tasks);
    return { callback, tasks };
  }

  try {
    const setup = await run({
      id: "nodb-command",
      type: 2,
      application_id: "test-application",
      token: "interaction-token",
      guild_id: "guild-id",
      channel_id: "channel-id",
      member: { user: { id: "creator-id" } },
      data: {
        name: "pbem-nodb",
        options: [
          { name: "name", value: "No DB Game" },
          { name: "mode", value: "both" },
        ],
      },
    });
    assert.deepEqual(setup.callback, { type: 5, data: { flags: 64 } });

    const selected = await run({
      id: "nodb-select",
      type: 3,
      token: "interaction-token",
      guild_id: "guild-id",
      channel_id: "channel-id",
      member: { user: { id: "creator-id" } },
      data: {
        component_type: 5,
        custom_id: "pbem:nodb:select:both",
        values: ["user-1", "user-2"],
        resolved: {
          users: {
            "user-1": { id: "user-1", username: "Player 1" },
            "user-2": { id: "user-2", username: "Player 2" },
          },
        },
      },
      message: { embeds: [{ title: "No DB Game" }] },
    });
    assert.deepEqual(selected.callback, { type: 6 });
    assert.match(String(boardMessage?.content), /only saved copy/);

    const components = boardMessage?.components as Array<{
      components: Array<{ custom_id: string }>;
    }>;
    const playerButton = components[0]!.components[1]!;
    const clicked = await run({
      id: "nodb-button",
      type: 3,
      token: "interaction-token",
      guild_id: "guild-id",
      channel_id: "channel-id",
      member: { user: { id: "user-2" } },
      data: { component_type: 2, custom_id: playerButton.custom_id },
      message: { id: "board-id" },
    });
    assert.deepEqual(clicked.callback, { type: 6 });
    assert.equal(postedBoards.length, 2);
    assert.match(String(postedBoards[1]?.content), /<@user-2>/);
    assert.deepEqual(postedBoards[1]?.allowed_mentions, { parse: [] });
    assert.deepEqual(messageOperations, ["post-board", "post-board", "delete-old"]);
    assert.equal(boardMessage?.id, "updated-board-id");
  } finally {
    if (previous.token === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = previous.token;
    if (previous.applicationId === undefined) delete process.env.DISCORD_APPLICATION_ID;
    else process.env.DISCORD_APPLICATION_ID = previous.applicationId;
    if (previous.publicKey === undefined) delete process.env.DISCORD_PUBLIC_KEY;
    else process.env.DISCORD_PUBLIC_KEY = previous.publicKey;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
    globalThis.fetch = previous.fetch;
    console.error = previous.consoleError;
  }
});

test("failed interactions are reported to the configured webhook without exposing tokens", async () => {
  const previous = {
    token: process.env.DISCORD_BOT_TOKEN,
    applicationId: process.env.DISCORD_APPLICATION_ID,
    publicKey: process.env.DISCORD_PUBLIC_KEY,
    databaseUrl: process.env.DATABASE_URL,
    errorWebhookUrl: process.env.PBEM_UPDATER_MAJOR_BUMP_NOTIFIER_WEBHOOK,
    fetch: globalThis.fetch,
    consoleError: console.error,
  };
  process.env.DISCORD_BOT_TOKEN = "test-token";
  process.env.DISCORD_APPLICATION_ID = "test-application";
  process.env.DISCORD_PUBLIC_KEY = publicKeyHex;
  delete process.env.DATABASE_URL;
  process.env.PBEM_UPDATER_MAJOR_BUMP_NOTIFIER_WEBHOOK =
    "https://discord.com/api/webhooks/123/webhook-secret";
  console.error = () => {};
  const reports: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;
    if (url === process.env.PBEM_UPDATER_MAJOR_BUMP_NOTIFIER_WEBHOOK) {
      reports.push(String(init?.body));
      return new Response(null, { status: 204 });
    }
    if (url.includes("/api/v10/webhooks/") && init?.method === "PATCH") {
      return new Response("mock interaction failure", { status: 500 });
    }
    if (url.includes("/api/v10/webhooks/") && init?.method === "POST") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${init?.method} ${url}`);
  };

  try {
    const tasks: Promise<unknown>[] = [];
    const interaction = {
      id: "failed-command-id",
      type: 2,
      token: "private-interaction-token",
      guild_id: "guild-id",
      channel_id: "channel-id",
      data: { name: "pbem-nodb" },
    };
    const response = await handleDiscordRequest(
      signedRequest(Buffer.from(JSON.stringify(interaction))),
      (task) => tasks.push(task),
    );
    assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
    await Promise.all(tasks);

    assert.equal(reports.length, 1);
    const report = JSON.parse(reports[0]!) as { content: string };
    assert.match(report.content, /PBEM interaction failed/);
    assert.match(report.content, /failed-command-id/);
    assert.match(report.content, /pbem-nodb/);
    assert.match(report.content, /mock interaction failure/);
    assert.doesNotMatch(report.content, /private-interaction-token|webhook-secret/);
  } finally {
    if (previous.token === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = previous.token;
    if (previous.applicationId === undefined) delete process.env.DISCORD_APPLICATION_ID;
    else process.env.DISCORD_APPLICATION_ID = previous.applicationId;
    if (previous.publicKey === undefined) delete process.env.DISCORD_PUBLIC_KEY;
    else process.env.DISCORD_PUBLIC_KEY = previous.publicKey;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
    if (previous.errorWebhookUrl === undefined) {
      delete process.env.PBEM_UPDATER_MAJOR_BUMP_NOTIFIER_WEBHOOK;
    } else {
      process.env.PBEM_UPDATER_MAJOR_BUMP_NOTIFIER_WEBHOOK = previous.errorWebhookUrl;
    }
    globalThis.fetch = previous.fetch;
    console.error = previous.consoleError;
  }
});

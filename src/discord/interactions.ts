import { createPublicKey, verify } from "node:crypto";
import { openRepository } from "../database/repository.js";
import { createInitialPlayers } from "../game/turns.js";
import type { GameMode, GameSnapshot, SelectedPlayer } from "../game/types.js";
import { buildGameBoard } from "../ui/game-board.js";

const DISCORD_API = "https://discord.com/api/v10";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const EPHEMERAL = 1 << 6;

interface DiscordUser {
  id?: string;
  username?: string;
  global_name?: string | null;
  bot?: boolean;
}

interface InteractionPayload {
  type?: number;
  application_id?: string;
  token?: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: DiscordUser };
  user?: DiscordUser;
  data?: {
    name?: string;
    custom_id?: string;
    component_type?: number;
    values?: string[];
    resolved?: { users?: Record<string, DiscordUser> };
    options?: Array<{ name?: string; value?: string }>;
  };
  message?: { id?: string };
}

interface RuntimeConfig {
  botToken: string;
  applicationId: string;
  publicKey: string;
  databaseUrl: string;
}

function getConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  const applicationId = env.DISCORD_APPLICATION_ID?.trim();
  const publicKey = env.DISCORD_PUBLIC_KEY?.trim();
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!botToken || !applicationId || !publicKey || !databaseUrl) {
    throw new Error(
      "DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY, and DATABASE_URL must be configured.",
    );
  }
  return { botToken, applicationId, publicKey, databaseUrl };
}

export function verifyDiscordSignature(
  body: Uint8Array,
  timestamp: string | null,
  signature: string | null,
  publicKeyHex: string,
): boolean {
  if (
    !timestamp ||
    !signature ||
    !/^[0-9a-f]{64}$/i.test(publicKeyHex) ||
    !/^[0-9a-f]{128}$/i.test(signature)
  ) {
    return false;
  }
  try {
    const key = createPublicKey({
      key: Buffer.concat([
        ED25519_SPKI_PREFIX,
        Buffer.from(publicKeyHex, "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]),
      key,
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}

async function reportBackgroundFailure(
  interaction: InteractionPayload,
  config: RuntimeConfig,
): Promise<void> {
  if (!interaction.token) return;
  const response = await fetch(
    `${DISCORD_API}/webhooks/${config.applicationId}/${interaction.token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "The request could not be completed. Please try again.",
        flags: EPHEMERAL,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Could not report the interaction failure (${response.status}): ${await response.text()}`,
    );
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function discordRequest(
  path: string,
  token: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetch(`${DISCORD_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Discord API ${init.method ?? "GET"} ${path} failed (${response.status}): ${details}`);
  }
  if (response.status === 204) return undefined;
  return response.json();
}

async function webhookRequest(
  applicationId: string,
  interactionToken: string,
  init: RequestInit,
): Promise<void> {
  const url = `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`;
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Discord interaction webhook failed (${response.status}): ${details}`);
  }
}

function optionValue(
  interaction: InteractionPayload,
  optionName: string,
): string | undefined {
  return interaction.data?.options?.find((option) => option.name === optionName)?.value;
}

function interactionUserId(interaction: InteractionPayload): string | undefined {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

function modeIsValid(value: string | undefined): value is GameMode {
  return value === "consecutive" || value === "simultaneous" || value === "both";
}

function interactionUserSelect(
  gameId: string,
  maxPlayers: number,
): Record<string, unknown> {
  return {
    type: 1,
    components: [
      {
        type: 5,
        custom_id: `pbem:select:${gameId}`,
        placeholder: "Select players",
        min_values: 1,
        max_values: maxPlayers,
      },
    ],
  };
}

async function postChannelMessage(
  channelId: string,
  token: string,
  payload: unknown,
): Promise<{ id: string }> {
  return (await discordRequest(
    `/channels/${channelId}/messages`,
    token,
    { method: "POST", body: JSON.stringify(payload) },
  )) as { id: string };
}

async function editOriginal(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  body: Record<string, unknown>,
): Promise<void> {
  if (!interaction.token) throw new Error("Interaction token is missing.");
  await webhookRequest(config.applicationId, interaction.token, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function createGameDraft(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  gameName: string,
  mode: GameMode,
): Promise<void> {
  let gameId: string | undefined;
  try {
    if (!interaction.guild_id || !interaction.channel_id || !interaction.user?.id && !interaction.member?.user?.id) {
      throw new Error("Create game interaction is missing server context.");
    }
    const creatorId = interactionUserId(interaction);
    if (!creatorId) throw new Error("Could not identify the game creator.");

    const repository = openRepository(config.databaseUrl);
    gameId = await repository.createDraft({
      name: gameName,
      mode,
      guildId: interaction.guild_id,
      channelId: interaction.channel_id,
      createdBy: creatorId,
    });
    const maxPlayers = mode === "both" ? 24 : 25;
    await editOriginal(interaction, config, {
      content: `Choose 1-${maxPlayers} players for **${gameName}**. The first selected player starts in consecutive mode.`,
      components: [interactionUserSelect(gameId, maxPlayers)],
    });
  } catch (error) {
    console.error("Could not create PBEM game setup:", error);
    if (gameId) {
      try {
        await openRepository(config.databaseUrl).deleteDraft(gameId);
      } catch (deleteError) {
        console.error("Could not remove the incomplete PBEM game setup:", deleteError);
      }
    }
    await editOriginal(interaction, config, {
      content: "The game could not be created. Please try `/pbem` again.",
      components: [],
    });
  }
}

function collectSelectedPlayers(interaction: InteractionPayload): SelectedPlayer[] {
  const values = interaction.data?.values ?? [];
  const users = interaction.data?.resolved?.users ?? {};
  const selected: SelectedPlayer[] = [];
  for (const userId of values) {
    const user = users[userId];
    if (!user || user.bot || !user.id || !user.username) continue;
    selected.push({
      userId: user.id,
      username: user.global_name ?? user.username,
    });
  }
  return selected;
}

async function setupGameFromUserPicker(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  gameId: string,
): Promise<void> {
  const creatorId = interactionUserId(interaction);
  if (!creatorId || !interaction.guild_id || !interaction.channel_id) {
    throw new Error("Player selection interaction is missing server context.");
  }
  const repository = openRepository(config.databaseUrl);
  let boardMessageId: string | undefined;
  let gameActivated = false;
  try {
    const draft = await repository.claimDraft(gameId, creatorId);
    if (!draft) {
      await editOriginal(interaction, config, {
        content: "This setup is no longer available. Start again with `/pbem`.",
        components: [],
      });
      return;
    }
    if (
      draft.game.guildId !== interaction.guild_id ||
      draft.game.channelId !== interaction.channel_id
    ) {
      await repository.releaseDraft(gameId);
      await editOriginal(interaction, config, {
        content: "This setup is no longer available. Start again with `/pbem`.",
        components: [],
      });
      return;
    }
    const selected = collectSelectedPlayers(interaction);
    const maxPlayers = draft.game.mode === "both" ? 24 : 25;
    if (selected.length === 0 || selected.length > maxPlayers) {
      await repository.releaseDraft(gameId);
      await editOriginal(interaction, config, {
        content:
          selected.length === 0
            ? "Select at least one non-bot player, then submit the picker again."
            : `This game supports up to ${maxPlayers} players. Run \`/pbem\` again to choose a valid roster.`,
      });
      return;
    }
    const activeMode = draft.game.mode === "both" ? "consecutive" : draft.game.mode;
    const initialSnapshot: GameSnapshot = {
      game: { ...draft.game, activeMode, status: "active" },
      players: createInitialPlayers(selected, activeMode, new Date().toISOString()),
    };
    const board = await postChannelMessage(
      draft.game.channelId,
      config.botToken,
      buildGameBoard(initialSnapshot, true),
    );
    boardMessageId = board.id;
    const snapshot = await repository.activateGame(gameId, selected, board.id);
    gameActivated = true;
    await editOriginal(interaction, config, {
      content: `Created **${snapshot.game.name}** with ${selected.length} player${selected.length === 1 ? "" : "s"}.`,
      components: [],
    });
  } catch (error) {
    console.error("Could not finish PBEM player setup:", error);
    if (gameActivated) return;
    if (boardMessageId) {
      try {
        await discordRequest(
          `/channels/${interaction.channel_id}/messages/${boardMessageId}`,
          config.botToken,
          { method: "DELETE" },
        );
      } catch (deleteError) {
        console.error("Could not remove a board whose game could not be saved:", deleteError);
      }
    }
    try {
      await repository.releaseDraft(gameId);
    } catch (releaseError) {
      console.error("Could not release the PBEM setup:", releaseError);
    }
    await editOriginal(interaction, config, {
      content: "The game could not be completed. Please run `/pbem` again.",
      components: [],
    });
  }
}

function pendingUserIds(snapshot: GameSnapshot): string[] {
  return snapshot.players
    .filter((player) => player.status === "pending")
    .map((player) => player.userId);
}

async function notifyPending(
  channelId: string,
  token: string,
  snapshot: GameSnapshot,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const mentions = userIds.map((userId) => `<@${userId}>`).join(", ");
  await postChannelMessage(channelId, token, {
    content: `It is now time for ${mentions} to take their turn in **${snapshot.game.name}**.`,
    allowed_mentions: { users: userIds },
  });
}

async function processBoardInteraction(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  action: string,
  gameId: string,
  playerId: string | undefined,
): Promise<void> {
  const messageId = interaction.message?.id;
  const guildId = interaction.guild_id;
  const channelId = interaction.channel_id;
  const actorId = interactionUserId(interaction);
  if (!messageId || !guildId || !channelId || !actorId) {
    throw new Error("Board interaction is missing game context.");
  }

  const repository = openRepository(config.databaseUrl);
  const current = await repository.getSnapshot(gameId);
  if (
    !current ||
    current.game.status !== "active" ||
    current.game.messageId !== messageId ||
    current.game.guildId !== guildId ||
    current.game.channelId !== channelId
  ) {
    return;
  }

  const result =
    action === "mode"
      ? await repository.switchGameMode(gameId, actorId)
      : await repository.applyPlayerSelection(gameId, playerId ?? "", actorId);
  await discordRequest(
    `/channels/${channelId}/messages/${messageId}`,
    config.botToken,
    { method: "PATCH", body: JSON.stringify(buildGameBoard(result)) },
  );
  await notifyPending(channelId, config.botToken, result, result.notifyUserIds);
}

async function processReminder(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  gameName: string,
): Promise<void> {
  try {
    const repository = openRepository(config.databaseUrl);
    const snapshot =
      interaction.guild_id && interaction.channel_id
        ? await repository.getActiveGameByName(
            interaction.guild_id,
            interaction.channel_id,
            gameName,
          )
        : null;
    if (
      !snapshot ||
      snapshot.game.status !== "active" ||
      !interaction.channel_id
    ) {
      await editOriginal(interaction, config, {
        content: "That game is not active in this channel.",
      });
      return;
    }
    const pending = pendingUserIds(snapshot);
    if (pending.length > 0) {
      await notifyPending(interaction.channel_id, config.botToken, snapshot, pending);
    }
    await editOriginal(interaction, config, {
      content: pending.length
        ? `Reminder sent for **${snapshot.game.name}**.`
        : `There are no pending players in **${snapshot.game.name}**.`,
    });
  } catch (error) {
    console.error("Could not send PBEM reminder:", error);
    await editOriginal(interaction, config, {
      content: "The reminder could not be sent. Please try again.",
    });
  }
}

function immediateResponse(type: number, data?: Record<string, unknown>): Response {
  return jsonResponse(data ? { type, data } : { type });
}

async function handleInteraction(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  schedule: (task: Promise<unknown>) => void,
): Promise<Response> {
  if (interaction.type === 1) return immediateResponse(1);
  if (interaction.type === 2) {
    const commandName = interaction.data?.name;
    if (commandName === "pbem") {
      const name = optionValue(interaction, "name")?.trim();
      const mode = optionValue(interaction, "mode");
      if (!name || name.length > 80 || !modeIsValid(mode)) {
        return immediateResponse(4, {
          content: "Provide a game name of 1-80 characters and select a valid mode.",
          flags: EPHEMERAL,
        });
      }
      if (!interaction.guild_id || !interaction.channel_id) {
        return immediateResponse(4, {
          content: "Use `/pbem` in a server channel.",
          flags: EPHEMERAL,
        });
      }
      const task = createGameDraft(interaction, config, name, mode);
      return scheduledResponse(5, { flags: EPHEMERAL }, task, schedule, interaction, config);
    }

    if (commandName === "pbem-remind") {
      const gameName = optionValue(interaction, "game")?.trim();
      if (!gameName || !interaction.guild_id || !interaction.channel_id) {
        return immediateResponse(4, {
          content: "Choose a game name and use `/pbem-remind` in the channel containing its board.",
          flags: EPHEMERAL,
        });
      }
      const task = processReminder(interaction, config, gameName);
      return scheduledResponse(5, { flags: EPHEMERAL }, task, schedule, interaction, config);
    }
  }

  if (interaction.type === 4) {
    return immediateResponse(8, { choices: [] });
  }

  if (interaction.type === 3) {
    const customId = interaction.data?.custom_id ?? "";
    if (interaction.data?.component_type === 5) {
      const [, action, gameId] = customId.split(":");
      if (action !== "select" || !gameId) {
        return immediateResponse(4, {
          content: "This player picker is invalid.",
          flags: EPHEMERAL,
        });
      }
      const task = setupGameFromUserPicker(interaction, config, gameId);
      return scheduledResponse(6, undefined, task, schedule, interaction, config);
    }

    const [, action, gameId, playerId] = customId.split(":");
    if (!gameId || (action !== "player" && action !== "mode")) {
      return immediateResponse(4, { content: "This button is invalid.", flags: EPHEMERAL });
    }
    const task = processBoardInteraction(interaction, config, action, gameId, playerId);
    return scheduledResponse(6, undefined, task, schedule, interaction, config);
  }

  return immediateResponse(4, {
    content: "This interaction is not supported.",
    flags: EPHEMERAL,
  });
}

function scheduledResponse(
  type: number,
  data: Record<string, unknown> | undefined,
  task: Promise<void>,
  schedule: (task: Promise<unknown>) => void,
  interaction: InteractionPayload,
  config: RuntimeConfig,
): Response {
  schedule(
    task.catch(async (error: unknown) => {
      console.error("Background Discord interaction failed:", error);
      try {
        await reportBackgroundFailure(interaction, config);
      } catch (reportError) {
        console.error("Could not report the background interaction failure:", reportError);
      }
    }),
  );
  return immediateResponse(type, data);
}

export async function handleDiscordRequest(
  request: Request,
  schedule: (task: Promise<unknown>) => void = (task) => {
    void task;
  },
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  let config: RuntimeConfig;
  try {
    config = getConfig();
  } catch (error) {
    console.error("Discord interaction endpoint is not configured:", error);
    return new Response("Service unavailable", { status: 503 });
  }

  const body = Buffer.from(await request.arrayBuffer());
  if (
    !verifyDiscordSignature(
      body,
      request.headers.get("x-signature-timestamp"),
      request.headers.get("x-signature-ed25519"),
      config.publicKey,
    )
  ) {
    return new Response("Invalid request signature", { status: 401 });
  }

  let interaction: InteractionPayload;
  try {
    interaction = JSON.parse(body.toString("utf8")) as InteractionPayload;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  try {
    return await handleInteraction(interaction, config, schedule);
  } catch (error) {
    console.error("Could not handle Discord interaction:", error);
    if (interaction.type === 1) {
      return immediateResponse(1);
    }
    if (interaction.type === 4) {
      return immediateResponse(8, { choices: [] });
    }
    return immediateResponse(4, {
      content: "The request could not be completed. Please try again.",
      flags: EPHEMERAL,
    });
  }
}

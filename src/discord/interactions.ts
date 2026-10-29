import { createPublicKey, verify } from "node:crypto";
import {
  GameNameInUseError,
  openRepository,
} from "../database/repository.js";
import { createInitialPlayers } from "../game/turns.js";
import type { GameMode, GameSnapshot, SelectedPlayer } from "../game/types.js";
import { buildGameBoard } from "../ui/game-board.js";

const DISCORD_API = "https://discord.com/api/v10";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const EPHEMERAL = 1 << 6;
const MAX_INTERACTION_AGE_MS = 5 * 60 * 1000;

interface DiscordUser {
  id?: string;
  username?: string;
  global_name?: string | null;
  bot?: boolean;
}

interface InteractionPayload {
  id?: string;
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
    options?: Array<{ name?: string; value?: string | number; focused?: boolean }>;
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
  if (!timestamp || !/^\d+$/.test(timestamp)) return false;
  const timestampSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Date.now() - timestampSeconds * 1000) > MAX_INTERACTION_AGE_MS ||
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
  const value = interaction.data?.options?.find((option) => option.name === optionName)?.value;
  return typeof value === "string" ? value : undefined;
}

function optionIntegerValue(
  interaction: InteractionPayload,
  optionName: string,
): number | undefined {
  const value = interaction.data?.options?.find((option) => option.name === optionName)?.value;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
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

function gameDeletionConfirmation(gameId: string): Record<string, unknown> {
  return {
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 4,
            label: "Delete game",
            custom_id: `pbem:delete-confirm:${gameId}`,
          },
          {
            type: 2,
            style: 2,
            label: "Cancel",
            custom_id: `pbem:delete-cancel:${gameId}`,
          },
        ],
      },
    ],
  };
}

function deleteAllConfirmation(): Record<string, unknown> {
  return {
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 4,
            label: "Delete all games",
            custom_id: "pbem:delete-all-confirm",
          },
          {
            type: 2,
            style: 2,
            label: "Cancel",
            custom_id: "pbem:delete-all-cancel",
          },
        ],
      },
    ],
  };
}

export function splitMessage(content: string, maxLength = 1900): string[] {
  if (maxLength < 1) throw new Error("Message length limit must be positive.");
  const chunks: string[] = [];
  let chunk = "";
  for (const line of content.split("\n")) {
    if (line.length > maxLength) {
      throw new Error("A game-list entry exceeds the Discord message limit.");
    }
    const candidate = chunk ? `${chunk}\n${line}` : line;
    if (candidate.length > maxLength) {
      chunks.push(chunk);
      chunk = line;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function activeGameChoices(
  games: Array<{ name: string }>,
  query: string,
): Array<{ name: string; value: string }> {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return games
    .filter((game) => game.name.toLocaleLowerCase().includes(normalizedQuery))
    .slice(0, 25)
    .map((game) => ({ name: game.name, value: game.name }));
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

async function deleteChannelMessage(
  channelId: string,
  messageId: string,
  token: string,
): Promise<void> {
  const response = await fetch(
    `${DISCORD_API}/channels/${channelId}/messages/${messageId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bot ${token}` },
    },
  );
  if (response.status === 404) return;
  if (!response.ok) {
    throw new Error(
      `Could not delete the game board (${response.status}): ${await response.text()}`,
    );
  }
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

async function postEphemeralFollowup(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  content: string,
): Promise<void> {
  if (!interaction.token) throw new Error("Interaction token is missing.");
  const response = await fetch(
    `${DISCORD_API}/webhooks/${config.applicationId}/${interaction.token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        flags: EPHEMERAL,
        allowed_mentions: { parse: [] },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Could not send game-list follow-up (${response.status}): ${await response.text()}`,
    );
  }
}

async function createGameDraft(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  gameName: string,
  mode: GameMode,
  reminderDays: number,
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
      reminderDays,
      guildId: interaction.guild_id,
      channelId: interaction.channel_id,
      createdBy: creatorId,
    });
    const maxPlayers = mode === "both" ? 24 : 25;
    await editOriginal(interaction, config, {
      content: `Choose 1-${maxPlayers} players for **${gameName}**. The first selected player starts in consecutive mode. Automated reminders: ${reminderDays === 0 ? "off" : `after ${reminderDays} days pending`}.`,
      components: [interactionUserSelect(gameId, maxPlayers)],
    });
  } catch (error) {
    if (!(error instanceof GameNameInUseError)) {
      console.error("Could not create PBEM game setup:", error);
    }
    if (gameId) {
      try {
        await openRepository(config.databaseUrl).deleteDraft(gameId);
      } catch (deleteError) {
        console.error("Could not remove the incomplete PBEM game setup:", deleteError);
      }
    }
    await editOriginal(interaction, config, {
      content:
        error instanceof GameNameInUseError
          ? "A game with that name already exists on this server. Choose a different name."
          : "The game could not be created. Please try `/pbem` again.",
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
      await repository.deleteDraft(gameId);
    } catch (deleteError) {
      console.error("Could not remove the incomplete PBEM setup:", deleteError);
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

async function sendPendingReminder(
  channelId: string,
  token: string,
  snapshot: GameSnapshot,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const mentions = userIds.map((userId) => `<@${userId}>`).join(", ");
  await postChannelMessage(channelId, token, {
    content: `Reminder for **${snapshot.game.name}**: ${mentions} have pending turns.`,
    allowed_mentions: { users: userIds },
  });
}

async function moveUpdatedBoardToLatest(
  repository: ReturnType<typeof openRepository>,
  gameId: string,
  token: string,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshot = await repository.getSnapshot(gameId);
    if (
      !snapshot ||
      snapshot.game.status !== "active" ||
      !snapshot.game.messageId
    ) {
      return;
    }

    const previousMessageId = snapshot.game.messageId;
    const nextMessage = await postChannelMessage(
      snapshot.game.channelId,
      token,
      buildGameBoard(snapshot),
    );
    const replaced = await repository.replaceBoardMessageId(
      gameId,
      previousMessageId,
      nextMessage.id,
    );
    if (replaced) {
      try {
        await deleteChannelMessage(
          snapshot.game.channelId,
          previousMessageId,
          token,
        );
      } catch (error) {
        console.error("Could not remove the previous PBEM board message:", error);
      }
      return;
    }

    try {
      await deleteChannelMessage(
        snapshot.game.channelId,
        nextMessage.id,
        token,
      );
    } catch (error) {
      console.error("Could not remove an outdated replacement PBEM board:", error);
    }
  }

  throw new Error("Could not move the PBEM board because it changed repeatedly.");
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
  await moveUpdatedBoardToLatest(repository, gameId, config.botToken);
}

async function processReminder(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  gameName: string,
): Promise<void> {
  try {
    const repository = openRepository(config.databaseUrl);
    const snapshot =
      interaction.guild_id
        ? await repository.getActiveGameByNameInGuild(interaction.guild_id, gameName)
        : null;
    if (!snapshot || snapshot.game.status !== "active") {
      await editOriginal(interaction, config, {
        content: "That game is not active in this server.",
      });
      return;
    }
    const pending = pendingUserIds(snapshot);
    if (pending.length > 0) {
      await sendPendingReminder(snapshot.game.channelId, config.botToken, snapshot, pending);
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

async function prepareGameDeletion(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  gameName: string,
): Promise<void> {
  if (!interaction.guild_id) {
    await editOriginal(interaction, config, {
      content: "Use `/pbem-delete` in a server.",
    });
    return;
  }

  const snapshot = await openRepository(config.databaseUrl)
    .getActiveGameByNameInGuild(interaction.guild_id, gameName);
  if (!snapshot) {
    await editOriginal(interaction, config, {
      content: "That game is not active in this server.",
    });
    return;
  }

  await editOriginal(interaction, config, {
    content: `Delete **${snapshot.game.name}** and its status board? This cannot be undone.`,
    ...gameDeletionConfirmation(snapshot.game.id),
  });
}

async function autocompleteActiveGame(
  interaction: InteractionPayload,
  config: RuntimeConfig,
): Promise<Response> {
  const focusedOption = interaction.data?.options?.find((option) => option.focused);
  if (
    !["pbem-delete", "pbem-reminders", "pbem-remind"].includes(interaction.data?.name ?? "") ||
    focusedOption?.name !== "game" ||
    !interaction.guild_id
  ) {
    return immediateResponse(8, { choices: [] });
  }

  const query = typeof focusedOption.value === "string" ? focusedOption.value : "";
  const games = await openRepository(config.databaseUrl)
    .listActiveGamesInGuild(interaction.guild_id);
  return immediateResponse(8, { choices: activeGameChoices(games.map(({ game }) => game), query) });
}

async function updateGameReminderDays(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  gameName: string,
  reminderDays: number,
): Promise<void> {
  if (!interaction.guild_id) {
    await editOriginal(interaction, config, {
      content: "Use `/pbem-reminders` in a server.",
    });
    return;
  }

  const snapshot = await openRepository(config.databaseUrl)
    .updateActiveGameReminderDays(interaction.guild_id, gameName, reminderDays);
  if (!snapshot) {
    await editOriginal(interaction, config, {
      content: "That game is no longer active in this server.",
    });
    return;
  }

  await editOriginal(interaction, config, {
    content: reminderDays === 0
      ? `Automated reminders are now off for **${snapshot.game.name}**.`
      : `Automated reminders for **${snapshot.game.name}** will be sent after ${reminderDays} day${reminderDays === 1 ? "" : "s"} pending.`,
  });
}

async function processGameDeletion(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  gameId: string,
): Promise<void> {
  if (!interaction.guild_id || !interactionUserId(interaction)) {
    throw new Error("Game deletion interaction is missing server or user context.");
  }

  const snapshot = await openRepository(config.databaseUrl)
    .deleteActiveGame(gameId, interaction.guild_id);
  if (!snapshot) {
    await editOriginal(interaction, config, {
      content: "That game is no longer active. Its name is available again.",
      components: [],
    });
    return;
  }

  try {
    if (snapshot.game.messageId) {
      await deleteChannelMessage(
        snapshot.game.channelId,
        snapshot.game.messageId,
        config.botToken,
      );
    }
  } catch (error) {
    console.error("Could not remove the deleted PBEM game board:", error);
    await editOriginal(interaction, config, {
      content: `Deleted **${snapshot.game.name}** and freed its name, but I could not remove its board message. Check the bot's channel permissions.`,
      components: [],
    });
    return;
  }

  await editOriginal(interaction, config, {
    content: `Deleted **${snapshot.game.name}** and freed its name.`,
    components: [],
  });
}

async function processGameList(
  interaction: InteractionPayload,
  config: RuntimeConfig,
): Promise<void> {
  if (!interaction.guild_id) {
    await editOriginal(interaction, config, {
      content: "Use `/pbem-list` in a server.",
    });
    return;
  }

  const games = await openRepository(config.databaseUrl)
    .listGamesInGuild(interaction.guild_id);
  if (games.length === 0) {
    await editOriginal(interaction, config, {
      content: "There are no PBEM games in this server.",
    });
    return;
  }

  const entries = games.map(({ game, players }) => {
    const safeName = game.name.replaceAll("@", "@\u200b");
    const reminderSetting = game.reminderDays === 0
      ? "reminders off"
      : `reminder after ${game.reminderDays} day${game.reminderDays === 1 ? "" : "s"}`;
    const state = game.status === "active"
      ? `${game.activeMode}; ${players.length} player${players.length === 1 ? "" : "s"}, ${players.filter((player) => player.status === "pending").length} pending; ${reminderSetting}`
      : "setup pending player selection";
    return `• **${safeName}** — ${state}; <#${game.channelId}>`;
  });
  const chunks = splitMessage(
    `**PBEM games in this server (${games.length}):**\n${entries.join("\n")}`,
  );
  await editOriginal(interaction, config, {
    content: chunks[0],
    allowed_mentions: { parse: [] },
  });
  for (const chunk of chunks.slice(1)) {
    await postEphemeralFollowup(interaction, config, chunk);
  }
}

async function prepareDeleteAllGames(
  interaction: InteractionPayload,
  config: RuntimeConfig,
): Promise<void> {
  if (!interaction.guild_id) {
    await editOriginal(interaction, config, {
      content: "Use `/pbem-delete-all` in a server.",
    });
    return;
  }

  const games = await openRepository(config.databaseUrl)
    .listGamesInGuild(interaction.guild_id);
  if (games.length === 0) {
    await editOriginal(interaction, config, {
      content: "There are no PBEM games to delete in this server.",
      components: [],
    });
    return;
  }

  await editOriginal(interaction, config, {
    content: `This will permanently delete all ${games.length} PBEM game${games.length === 1 ? "" : "s"} in this server, including pending setups, and remove their boards. This cannot be undone. Confirm to continue.`,
    ...deleteAllConfirmation(),
  });
}

async function processDeleteAllGames(
  interaction: InteractionPayload,
  config: RuntimeConfig,
): Promise<void> {
  if (!interaction.guild_id || !interactionUserId(interaction)) {
    throw new Error("Bulk game deletion is missing server or user context.");
  }

  const games = await openRepository(config.databaseUrl)
    .deleteAllGamesInGuild(interaction.guild_id);
  if (games.length === 0) {
    await editOriginal(interaction, config, {
      content: "There are no games left to delete in this server.",
      components: [],
    });
    return;
  }

  const boards = games.flatMap(({ game }) =>
    game.messageId
      ? [{ name: game.name, channelId: game.channelId, messageId: game.messageId }]
      : [],
  );
  let failedBoards = 0;
  for (let index = 0; index < boards.length; index += 5) {
    const results = await Promise.all(
      boards.slice(index, index + 5).map(async (board) => {
        try {
          await deleteChannelMessage(board.channelId, board.messageId, config.botToken);
          return true;
        } catch (error) {
          console.error(`Could not remove the board for deleted PBEM game "${board.name}":`, error);
          return false;
        }
      }),
    );
    failedBoards += results.filter((success) => !success).length;
  }
  const message =
    failedBoards === 0
      ? `Deleted ${games.length} PBEM game${games.length === 1 ? "" : "s"} and freed their names.`
      : `Deleted ${games.length} PBEM game${games.length === 1 ? "" : "s"} and freed their names, but could not remove ${failedBoards} board message${failedBoards === 1 ? "" : "s"}. Check the bot's channel permissions.`;
  await editOriginal(interaction, config, {
    content: message,
    components: [],
    allowed_mentions: { parse: [] },
  });
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
      const reminderDays = optionIntegerValue(interaction, "reminder-days") ?? 0;
      if (
        !name ||
        name.length > 80 ||
        !modeIsValid(mode) ||
        reminderDays < 0 ||
        reminderDays > 365
      ) {
        return immediateResponse(4, {
          content: "Provide a game name of 1-80 characters, select a valid mode, and choose reminder days from 0-365.",
          flags: EPHEMERAL,
        });
      }
      if (!interaction.guild_id || !interaction.channel_id) {
        return immediateResponse(4, {
          content: "Use `/pbem` in a server channel.",
          flags: EPHEMERAL,
        });
      }
      const task = createGameDraft(interaction, config, name, mode, reminderDays);
      return scheduledResponse(5, { flags: EPHEMERAL }, task, schedule, interaction, config);
    }

    if (commandName === "pbem-remind") {
      const gameName = optionValue(interaction, "game")?.trim();
      if (!gameName || !interaction.guild_id) {
        return immediateResponse(4, {
          content: "Choose an active game and use `/pbem-remind` in a server.",
          flags: EPHEMERAL,
        });
      }
      const task = processReminder(interaction, config, gameName);
      return scheduledResponse(5, { flags: EPHEMERAL }, task, schedule, interaction, config);
    }

    if (commandName === "pbem-reminders") {
      const gameName = optionValue(interaction, "game")?.trim();
      const reminderDays = optionIntegerValue(interaction, "days");
      if (!gameName || gameName.length > 80 || reminderDays === undefined || reminderDays < 0 || reminderDays > 365) {
        return immediateResponse(4, {
          content: "Choose an active game and set reminder days from 0-365.",
          flags: EPHEMERAL,
        });
      }
      if (!interaction.guild_id) {
        return immediateResponse(4, {
          content: "Use `/pbem-reminders` in a server.",
          flags: EPHEMERAL,
        });
      }
      const task = updateGameReminderDays(interaction, config, gameName, reminderDays);
      return scheduledResponse(5, { flags: EPHEMERAL }, task, schedule, interaction, config);
    }

    if (commandName === "pbem-delete") {
      const gameName = optionValue(interaction, "game")?.trim();
      if (!gameName || gameName.length > 80 || !interaction.guild_id) {
        return immediateResponse(4, {
          content: "Choose an active game and use `/pbem-delete` in a server.",
          flags: EPHEMERAL,
        });
      }
      const task = prepareGameDeletion(interaction, config, gameName);
      return scheduledResponse(5, { flags: EPHEMERAL }, task, schedule, interaction, config);
    }

    if (commandName === "pbem-list") {
      if (!interaction.guild_id) {
        return immediateResponse(4, {
          content: "Use `/pbem-list` in a server.",
          flags: EPHEMERAL,
        });
      }
      const task = processGameList(interaction, config);
      return scheduledResponse(5, { flags: EPHEMERAL }, task, schedule, interaction, config);
    }

    if (commandName === "pbem-delete-all") {
      if (!interaction.guild_id) {
        return immediateResponse(4, {
          content: "Use `/pbem-delete-all` in a server.",
          flags: EPHEMERAL,
        });
      }
      const task = prepareDeleteAllGames(interaction, config);
      return scheduledResponse(5, { flags: EPHEMERAL }, task, schedule, interaction, config);
    }
  }

  if (interaction.type === 4) {
    try {
      return await autocompleteActiveGame(interaction, config);
    } catch (error) {
      console.error("Could not load active game suggestions:", error);
      return immediateResponse(8, { choices: [] });
    }
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
    if (action === "delete-cancel" && gameId) {
      return immediateResponse(7, {
        content: "Game deletion cancelled.",
        components: [],
      });
    }
    if (action === "delete-confirm" && gameId) {
      const task = processGameDeletion(interaction, config, gameId);
      return scheduledResponse(6, undefined, task, schedule, interaction, config);
    }
    if (action === "delete-all-cancel") {
      return immediateResponse(7, {
        content: "Bulk deletion cancelled.",
        components: [],
      });
    }
    if (action === "delete-all-confirm") {
      const task = processDeleteAllGames(interaction, config);
      return scheduledResponse(6, undefined, task, schedule, interaction, config);
    }
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

async function processClaimedInteraction(
  interaction: InteractionPayload,
  config: RuntimeConfig,
): Promise<void> {
  const interactionId = interaction.id;
  if (!interactionId) throw new Error("Interaction ID is missing.");

  const claimed = await openRepository(config.databaseUrl).claimInteraction(interactionId);
  if (!claimed) {
    if (interaction.type === 2) {
      await editOriginal(interaction, config, {
        content: "This interaction was already processed.",
        components: [],
      });
    } else {
      await postEphemeralFollowup(
        interaction,
        config,
        "This interaction was already processed.",
      );
    }
    return;
  }

  const tasks: Promise<unknown>[] = [];
  const response = await handleInteraction(interaction, config, (task) => {
    tasks.push(task);
  });
  const callback = await response.json() as {
    type?: number;
    data?: { content?: string };
  };
  if (callback.type === 4 && callback.data?.content) {
    if (interaction.type === 2) {
      await editOriginal(interaction, config, {
        content: callback.data.content,
        components: [],
      });
    } else {
      await postEphemeralFollowup(interaction, config, callback.data.content);
    }
  }
  await Promise.all(tasks);
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

  if (interaction.type === 2 || interaction.type === 3) {
    if (!interaction.id || interaction.id.length > 64) {
      return new Response("Invalid interaction ID", { status: 400 });
    }
    return scheduledResponse(
      interaction.type === 2 ? 5 : 6,
      interaction.type === 2 ? { flags: EPHEMERAL } : undefined,
      processClaimedInteraction(interaction, config),
      schedule,
      interaction,
      config,
    );
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

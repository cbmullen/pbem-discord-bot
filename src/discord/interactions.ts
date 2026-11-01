import { createPublicKey, randomUUID, verify } from "node:crypto";
import {
  GameNameInUseError,
  openRepository,
  type PlayerRosterChange,
} from "../database/repository.js";
import {
  activeAway,
  awayPlayers,
  isGamePaused,
  parseAwayUntil,
} from "../game/away.js";
import { PlayerRosterError } from "../game/players.js";
import { createInitialPlayers } from "../game/turns.js";
import type { GameMode, GameSnapshot, SelectedPlayer } from "../game/types.js";
import { buildGameBoard } from "../ui/game-board.js";
import { buildGameStatusEmbed } from "../ui/game-status.js";
import {
  buildNoDbGameBoard,
  readNoDbBoardState,
  updateNoDbGameBoard,
} from "../ui/nodb-game-board.js";
import type { NoDbDiscordMessage } from "../ui/nodb-game-board.js";

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
  message?: {
    id?: string;
    embeds?: Array<{ title?: string }>;
  };
}

interface RuntimeConfig {
  botToken: string;
  applicationId: string;
  publicKey: string;
  databaseUrl: string;
  errorWebhookUrl: string;
}

function getConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  const applicationId = env.DISCORD_APPLICATION_ID?.trim();
  const publicKey = env.DISCORD_PUBLIC_KEY?.trim();
  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  const errorWebhookUrl = env.PBEM_UPDATER_MAJOR_BUMP_NOTIFIER_WEBHOOK?.trim() ?? "";
  if (!botToken || !applicationId || !publicKey) {
    throw new Error(
      "DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, and DISCORD_PUBLIC_KEY must be configured.",
    );
  }
  return { botToken, applicationId, publicKey, databaseUrl, errorWebhookUrl };
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

function interactionAction(interaction: InteractionPayload): string {
  const commandName = interaction.data?.name;
  if (commandName) return commandName;
  const customId = interaction.data?.custom_id;
  if (!customId) return "unknown";
  return customId
    .split(":")
    .slice(0, 3)
    .join(":")
    .replace(/@/g, "@\u200b")
    .replace(/[\\`]/g, "'")
    .slice(0, 120);
}

function safeErrorSummary(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "postgresql://[REDACTED]")
    .replace(/\/webhooks\/\d+\/[A-Za-z0-9._-]+/g, "/webhooks/[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/@/g, "@\u200b")
    .replace(/[\\`]/g, "'")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 900);
}

async function reportInteractionError(
  error: unknown,
  interaction: InteractionPayload,
  config: RuntimeConfig,
): Promise<void> {
  if (!config.errorWebhookUrl) return;
  const content = [
    "⚠️ **PBEM interaction failed**",
    `Time: ${new Date().toISOString()}`,
    `Environment: ${process.env.VERCEL_ENV ?? "unknown"}`,
    `Interaction: \`${interaction.id ?? "unknown"}\` (type ${interaction.type ?? "unknown"})`,
    `Action: \`${interactionAction(interaction)}\``,
    `Server: \`${interaction.guild_id ?? "DM/unknown"}\`; channel: \`${interaction.channel_id ?? "unknown"}\``,
    `Error: \`${safeErrorSummary(error)}\``,
  ].join("\n");
  const response = await fetch(config.errorWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    const details = (await response.text()).slice(0, 300);
    throw new Error(
      `Could not send PBEM interaction failure report (${response.status}): ${details}`,
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

function playerManagementPicker(
  snapshot: GameSnapshot,
  action: "add" | "remove",
): Record<string, unknown> {
  if (action === "add") {
    const maxPlayers = snapshot.game.mode === "both" ? 24 : 25;
    return {
      type: 1,
      components: [
        {
          type: 5,
          custom_id: `pbem:players:add:${snapshot.game.id}`,
          placeholder: "Select server members to add",
          min_values: 1,
          max_values: maxPlayers - snapshot.players.length,
        },
      ],
    };
  }
  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: `pbem:players:remove:${snapshot.game.id}`,
        placeholder: "Select players to remove",
        min_values: 1,
        max_values: snapshot.players.length,
        options: snapshot.players.map((player) => ({
          label: player.username.slice(0, 100),
          description: `Currently ${player.status}`,
          value: player.userId,
        })),
      },
    ],
  };
}

function teamManagementPicker(
  snapshot: GameSnapshot,
  action: "add" | "remove",
): Record<string, unknown> {
  if (action === "add") {
    return {
      type: 1,
      components: [
        {
          type: 5,
          custom_id: `pbem:teams:add:${snapshot.game.id}`,
          placeholder: "Select 2-8 server members",
          min_values: 2,
          max_values: 8,
        },
      ],
    };
  }
  const teams = snapshot.players.filter(
    (player) => (player.notificationUserIds?.length ?? 0) > 1,
  );
  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: `pbem:teams:remove:${snapshot.game.id}`,
        placeholder: "Select shared teams to remove",
        min_values: 1,
        max_values: teams.length,
        options: teams.map((team) => ({
          label: team.username.slice(0, 100),
          description: `Currently ${team.status}`,
          value: team.userId,
        })),
      },
    ],
  };
}

function noDbUserSelect(mode: GameMode, maxPlayers: number): Record<string, unknown> {
  return {
    type: 1,
    components: [
      {
        type: 5,
        custom_id: `pbem:nodb:select:${mode}`,
        placeholder: "Select players",
        min_values: 1,
        max_values: maxPlayers,
      },
    ],
  };
}

async function prepareNoDbGame(
  interaction: InteractionPayload,
  config: RuntimeConfig,
): Promise<void> {
  const name = optionValue(interaction, "name")?.trim();
  const mode = optionValue(interaction, "mode");
  if (!name || name.length > 80 || !modeIsValid(mode)) {
    await editOriginal(interaction, config, {
      content: "Provide a game name of 1-80 characters and select a valid mode.",
      components: [],
    });
    return;
  }
  if (!interaction.guild_id || !interaction.channel_id) {
    await editOriginal(interaction, config, {
      content: "Use `/pbem-nodb` in a server channel.",
      components: [],
    });
    return;
  }

  await editOriginal(interaction, config, {
    content: `Choose players for **${name.replaceAll("@", "@\u200b")}**. This board is not saved in Neon.`,
    embeds: [{ title: name }],
    components: [noDbUserSelect(mode, mode === "both" ? 24 : 25)],
    allowed_mentions: { parse: [] },
  });
}

async function finishNoDbGameSetup(
  interaction: InteractionPayload,
  config: RuntimeConfig,
): Promise<void> {
  const [prefix, namespace, action, modeValue] =
    interaction.data?.custom_id?.split(":") ?? [];
  const name = interaction.message?.embeds?.[0]?.title;
  if (
    prefix !== "pbem" ||
    namespace !== "nodb" ||
    action !== "select" ||
    !modeIsValid(modeValue) ||
    !name ||
    !interaction.guild_id ||
    !interaction.channel_id
  ) {
    await editOriginal(interaction, config, {
      content: "This no-database game setup is invalid. Run `/pbem-nodb` again.",
      components: [],
      embeds: [],
    });
    return;
  }

  const selected = collectSelectedPlayers(interaction);
  const maxPlayers = modeValue === "both" ? 24 : 25;
  if (selected.length === 0 || selected.length > maxPlayers) {
    await editOriginal(interaction, config, {
      content: selected.length === 0
        ? "Select at least one non-bot player, then submit the picker again."
        : `This game supports up to ${maxPlayers} players. Run \`/pbem-nodb\` again to choose a valid roster.`,
    });
    return;
  }

  const now = new Date().toISOString();
  const creatorId = interactionUserId(interaction);
  if (!creatorId) throw new Error("No-database game setup is missing its creator.");
  const gameId = randomUUID();
  const activeMode = modeValue === "both" ? "consecutive" : modeValue;
  const snapshot: GameSnapshot = {
    game: {
      id: gameId,
      name,
      mode: modeValue,
      activeMode,
      reminderDays: 0,
      guildId: interaction.guild_id,
      channelId: interaction.channel_id,
      messageId: null,
      createdBy: creatorId,
      createdAt: now,
      status: "active",
    },
    players: createInitialPlayers(selected, activeMode, now),
  };
  await postChannelMessage(
    interaction.channel_id,
    config.botToken,
    buildNoDbGameBoard(snapshot, true),
  );
  await editOriginal(interaction, config, {
    content: `Created **${name.replaceAll("@", "@\u200b")}** without using Neon. The Discord board is the only saved copy.`,
    components: [],
    embeds: [],
    allowed_mentions: { parse: [] },
  });
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

function gameWinnerPicker(snapshot: GameSnapshot): Record<string, unknown> {
  return {
    components: [
      {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: `pbem:gameover:${snapshot.game.id}`,
            placeholder: "Choose the winning player or team",
            min_values: 1,
            max_values: 1,
            options: snapshot.players.map((player) => ({
              label: player.username.slice(0, 100),
              description: player.status === "pending" ? "Currently pending" : "Currently done",
              value: player.userId,
            })),
          },
        ],
      },
    ],
  };
}

function gameoverConfirmation(gameId: string): Record<string, unknown> {
  return {
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: "Continue to winner selection",
            custom_id: `pbem:gameover-confirm:${gameId}`,
          },
          {
            type: 2,
            style: 2,
            label: "Cancel",
            custom_id: `pbem:gameover-cancel:${gameId}`,
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

function isNoDbDiscordMessage(value: unknown): value is NoDbDiscordMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as { content?: unknown; components?: unknown };
  return (
    typeof message.content === "string" &&
    Array.isArray(message.components) &&
    message.components.every((row) =>
      !!row &&
      typeof row === "object" &&
      typeof row.type === "number" &&
      (row.components === undefined ||
        Array.isArray(row.components) &&
          row.components.every((component: unknown) =>
            !!component && typeof component === "object" &&
            typeof (component as { type?: unknown }).type === "number",
          )),
    )
  );
}

async function getNoDbBoardMessage(
  channelId: string,
  messageId: string,
  token: string,
): Promise<NoDbDiscordMessage> {
  const message = await discordRequest(
    `/channels/${channelId}/messages/${messageId}`,
    token,
    { method: "GET" },
  );
  if (!isNoDbDiscordMessage(message)) {
    throw new Error("Discord returned an invalid no-database game board.");
  }
  return message;
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

async function preparePlayerManagement(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  gameName: string,
  action: "add" | "remove",
): Promise<void> {
  const guildId = interaction.guild_id;
  if (!guildId) throw new Error("Player management requires a server.");
  const snapshot = await openRepository(config.databaseUrl)
    .getActiveGameByNameInGuild(guildId, gameName);
  if (!snapshot) {
    await editOriginal(interaction, config, {
      content: "That game is not active in this server.",
      components: [],
    });
    return;
  }
  if (action === "add") {
    const maxPlayers = snapshot.game.mode === "both" ? 24 : 25;
    if (snapshot.players.length >= maxPlayers) {
      await editOriginal(interaction, config, {
        content: `This game already has the maximum of ${maxPlayers} players.`,
        components: [],
      });
      return;
    }
  }
  await editOriginal(interaction, config, {
    content: `Choose players to ${action} in **${snapshot.game.name.replaceAll("@", "@\u200b")}**.`,
    components: [playerManagementPicker(snapshot, action)],
    allowed_mentions: { parse: [] },
  });
}

async function prepareTeamManagement(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  gameName: string,
  action: "add" | "remove",
): Promise<void> {
  const guildId = interaction.guild_id;
  if (!guildId) throw new Error("Team management requires a server.");
  const snapshot = await openRepository(config.databaseUrl)
    .getActiveGameByNameInGuild(guildId, gameName);
  if (!snapshot) {
    await editOriginal(interaction, config, {
      content: "That game is not active in this server.",
      components: [],
    });
    return;
  }
  const maxPlayers = snapshot.game.mode === "both" ? 24 : 25;
  const teams = snapshot.players.filter(
    (player) => (player.notificationUserIds?.length ?? 0) > 1,
  );
  if (action === "add" && snapshot.players.length >= maxPlayers) {
    await editOriginal(interaction, config, {
      content: `This game already has the maximum of ${maxPlayers} players.`,
      components: [],
    });
    return;
  }
  if (action === "remove" && teams.length === 0) {
    await editOriginal(interaction, config, {
      content: "This game has no shared teams to remove.",
      components: [],
    });
    return;
  }
  await editOriginal(interaction, config, {
    content: `Choose members to ${action === "add" ? "add as a shared team to" : "remove as a shared team from"} **${snapshot.game.name.replaceAll("@", "@\u200b")}**.`,
    components: [teamManagementPicker(snapshot, action)],
    allowed_mentions: { parse: [] },
  });
}

async function processPlayerManagementSelection(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  action: "add" | "remove",
  gameId: string,
): Promise<void> {
  const guildId = interaction.guild_id;
  const actorId = interactionUserId(interaction);
  if (!guildId || !actorId) throw new Error("Player selection is missing server context.");

  const repository = openRepository(config.databaseUrl);
  const snapshot = await repository.getSnapshot(gameId);
  if (
    !snapshot ||
    snapshot.game.status !== "active" ||
    snapshot.game.guildId !== guildId ||
    !snapshot.game.messageId
  ) {
    await editOriginal(interaction, config, {
      content: "That game is no longer active in this server.",
      components: [],
    });
    return;
  }

  let change: PlayerRosterChange;
  let selectedIds: string[];
  if (action === "add") {
    const values = interaction.data?.values ?? [];
    const players = collectSelectedPlayers(interaction);
    if (players.length === 0 || players.length !== values.length) {
      await editOriginal(interaction, config, {
        content: "Select at least one non-bot server member to add.",
        components: [],
      });
      return;
    }
    change = { type: "add", players };
    selectedIds = players.map((player) => player.userId);
  } else {
    selectedIds = interaction.data?.values ?? [];
    if (selectedIds.length === 0) {
      await editOriginal(interaction, config, {
        content: "Select at least one current game player to remove.",
        components: [],
      });
      return;
    }
    change = { type: "remove", userIds: selectedIds };
  }

  let updated: GameSnapshot;
  try {
    updated = await repository.updateGamePlayers(gameId, change, actorId);
  } catch (error) {
    if (!(error instanceof PlayerRosterError)) throw error;
    await editOriginal(interaction, config, {
      content: error.message,
      components: [],
    });
    return;
  }
  const newlyPending = action === "add"
    ? updated.players
      .filter((player) => selectedIds.includes(player.userId) && player.status === "pending")
      .map((player) => player.userId)
    : [];
  await moveUpdatedBoardToLatest(repository, gameId, config.botToken, newlyPending);
  await editOriginal(interaction, config, {
    content: `${action === "add" ? "Added" : "Removed"} ${selectedIds.length} player${selectedIds.length === 1 ? "" : "s"} ${action === "add" ? "to" : "from"} **${snapshot.game.name}**.`,
    components: [],
    allowed_mentions: { parse: [] },
  });
}

async function processTeamManagementSelection(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  action: "add" | "remove",
  gameId: string,
): Promise<void> {
  const guildId = interaction.guild_id;
  const actorId = interactionUserId(interaction);
  if (!guildId || !actorId) throw new Error("Team selection is missing server context.");
  const repository = openRepository(config.databaseUrl);
  const snapshot = await repository.getSnapshot(gameId);
  if (
    !snapshot ||
    snapshot.game.status !== "active" ||
    snapshot.game.guildId !== guildId ||
    !snapshot.game.messageId
  ) {
    await editOriginal(interaction, config, {
      content: "That game is no longer active in this server.",
      components: [],
    });
    return;
  }

  const values = interaction.data?.values ?? [];
  let change: PlayerRosterChange;
  let affectedUserIds: string[];
  if (action === "add") {
    const members = collectSelectedPlayers(interaction);
    if (
      members.length < 2 ||
      members.length > 8 ||
      members.length !== values.length
    ) {
      await editOriginal(interaction, config, {
        content: "Select 2-8 non-bot server members for a shared team.",
        components: [],
      });
      return;
    }
    change = { type: "add-team", members };
    affectedUserIds = members.map((member) => member.userId);
  } else {
    if (values.length === 0) {
      await editOriginal(interaction, config, {
        content: "Select at least one shared team to remove.",
        components: [],
      });
      return;
    }
    change = { type: "remove-team", teamIds: values };
    affectedUserIds = values;
  }

  let updated: GameSnapshot;
  try {
    updated = await repository.updateGamePlayers(gameId, change, actorId);
  } catch (error) {
    if (error instanceof PlayerRosterError) {
      await editOriginal(interaction, config, {
        content: error.message,
        components: [],
      });
      return;
    }
    throw error;
  }
  const pendingMembers = action === "add"
    ? updated.players
      .filter((player) =>
        affectedUserIds.some((userId) =>
          (player.notificationUserIds ?? [player.userId]).includes(userId),
        ) && player.status === "pending",
      )
      .flatMap((player) => player.notificationUserIds ?? [player.userId])
    : [];
  await moveUpdatedBoardToLatest(repository, gameId, config.botToken, pendingMembers);
  await editOriginal(interaction, config, {
    content: action === "add"
      ? `Added a shared ${affectedUserIds.length}-person team to **${snapshot.game.name}**.`
      : `Removed ${affectedUserIds.length} shared team${affectedUserIds.length === 1 ? "" : "s"} from **${snapshot.game.name}**.`,
    components: [],
    allowed_mentions: { parse: [] },
  });
}

function collectSelectedPlayers(interaction: InteractionPayload): SelectedPlayer[] {
  const values = interaction.data?.values ?? [];
  const users = interaction.data?.resolved?.users ?? {};
  const selected: SelectedPlayer[] = [];
  for (const userId of values) {
    const user = users[userId];
    if (!user || user.bot || user.id !== userId || !user.username) continue;
    selected.push({
      userId: user.id,
      username: user.global_name?.trim() || user.username,
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
      away: await repository.getAwayMap(
        draft.game.guildId,
        selected.map((player) => player.userId),
      ),
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

async function processNoDbBoardButton(
  interaction: InteractionPayload,
  config: RuntimeConfig,
): Promise<void> {
  const messageId = interaction.message?.id;
  const channelId = interaction.channel_id;
  const customId = interaction.data?.custom_id;
  if (!messageId || !channelId || !interaction.guild_id || !interactionUserId(interaction) || !customId) {
    throw new Error("No-database board interaction is missing game context.");
  }

  const message = await getNoDbBoardMessage(channelId, messageId, config.botToken);
  const state = readNoDbBoardState(message);
  if (!message.components.some((row) =>
    row.components?.some((button) => button.custom_id === customId),
  )) {
    await postEphemeralFollowup(
      interaction,
      config,
      "That no-database board has changed. Please click a current button.",
    );
    return;
  }

  const updated = updateNoDbGameBoard(message, customId);
  // shortcut: Discord cannot conditionally edit a message; simultaneous clicks can race while this board has no shared lock.
  await postChannelMessage(
    channelId,
    config.botToken,
    {
      content: updated.content,
      components: updated.components,
      allowed_mentions: { parse: [] },
    },
  );
  try {
    await deleteChannelMessage(channelId, messageId, config.botToken);
  } catch (error) {
    console.error("Could not remove the previous no-database board message:", error);
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

export async function moveUpdatedBoardToLatest(
  repository: ReturnType<typeof openRepository>,
  gameId: string,
  token: string,
  announceUserIds: string[] = [],
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
    const board = buildGameBoard(snapshot);
    if (announceUserIds.length > 0) {
      board.allowed_mentions.users = snapshot.players
        .filter((player) =>
          player.status === "pending" &&
          (player.notificationUserIds ?? [player.userId])
            .some((userId) => announceUserIds.includes(userId)),
        )
        .flatMap((player) => player.notificationUserIds ?? [player.userId])
        .filter((userId) => announceUserIds.includes(userId));
    }
    const nextMessage = await postChannelMessage(
      snapshot.game.channelId,
      token,
      board,
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

function discordDate(until: string): string {
  const seconds = Math.floor(Date.parse(until) / 1000);
  return Number.isFinite(seconds) ? `<t:${seconds}:D>` : "an unknown date";
}

// Reposts the board of every active game the player is in so "paused" and the
// away buttons appear (or disappear) straight away.
async function refreshBoardsForPlayer(
  repository: ReturnType<typeof openRepository>,
  config: RuntimeConfig,
  guildId: string,
  userId: string,
): Promise<{ names: string[]; failed: string[] }> {
  const games = await repository.listActiveGamesForPlayer(guildId, userId);
  const failed: string[] = [];
  for (const { game } of games) {
    try {
      await moveUpdatedBoardToLatest(repository, game.id, config.botToken);
    } catch (error) {
      console.error("Could not refresh a PBEM board after an away change:", error);
      failed.push(game.name);
    }
  }
  return { names: games.map(({ game }) => game.name), failed };
}

function gameNameList(names: string[]): string {
  return names.map((name) => `**${name}**`).join(", ");
}

async function processAway(
  interaction: InteractionPayload,
  config: RuntimeConfig,
): Promise<void> {
  const guildId = interaction.guild_id;
  const actorId = interactionUserId(interaction);
  if (!guildId || !actorId) {
    throw new Error("Away interaction is missing server or user context.");
  }
  const targetId = optionValue(interaction, "player") ?? actorId;
  if (interaction.data?.resolved?.users?.[targetId]?.bot) {
    await editOriginal(interaction, config, { content: "Bots cannot be marked as away." });
    return;
  }

  let until: string | null = null;
  const untilInput = optionValue(interaction, "until")?.trim();
  if (untilInput) {
    const parsed = parseAwayUntil(untilInput);
    if (!parsed.ok) {
      await editOriginal(interaction, config, { content: parsed.error });
      return;
    }
    until = parsed.until;
  }

  const repository = openRepository(config.databaseUrl);
  await repository.setAway(guildId, targetId, until, actorId);
  const { names, failed } = await refreshBoardsForPlayer(repository, config, guildId, targetId);

  const when = until ? ` until ${discordDate(until)}` : " with no return date";
  const lines = [`<@${targetId}> is now away${when}.`];
  lines.push(
    names.length > 0
      ? `Paused: ${gameNameList(names)}. Reminders stay off in those games until nobody in them is away.`
      : "They are not in an active game here yet; this applies to any game they are added to.",
  );
  if (failed.length > 0) {
    lines.push(`I could not update the board for ${gameNameList(failed)}; it will refresh on its next click.`);
  }
  lines.push("Use `/pbem-back` to clear it early.");
  await editOriginal(interaction, config, {
    content: lines.join("\n"),
    allowed_mentions: { parse: [] },
  });
}

async function processBack(
  interaction: InteractionPayload,
  config: RuntimeConfig,
): Promise<void> {
  const guildId = interaction.guild_id;
  const actorId = interactionUserId(interaction);
  if (!guildId || !actorId) {
    throw new Error("Back interaction is missing server or user context.");
  }
  const targetId = optionValue(interaction, "player") ?? actorId;
  const repository = openRepository(config.databaseUrl);
  const wasAway = await repository.clearAway(guildId, targetId);
  if (!wasAway) {
    await editOriginal(interaction, config, {
      content: `<@${targetId}> is not marked as away.`,
      allowed_mentions: { parse: [] },
    });
    return;
  }

  const { names, failed } = await refreshBoardsForPlayer(repository, config, guildId, targetId);
  const lines = [`<@${targetId}> is back.`];
  if (names.length > 0) {
    lines.push(
      `Updated: ${gameNameList(names)}. A game stays paused while anyone else in it is still away.`,
    );
  }
  if (failed.length > 0) {
    lines.push(`I could not update the board for ${gameNameList(failed)}; it will refresh on its next click.`);
  }
  await editOriginal(interaction, config, {
    content: lines.join("\n"),
    allowed_mentions: { parse: [] },
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
    if (isGamePaused(snapshot.players, snapshot.away)) {
      const away = awayPlayers(snapshot.players, snapshot.away)
        .map((player) => `<@${player.userId}>`)
        .join(", ");
      await editOriginal(interaction, config, {
        content: `**${snapshot.game.name}** is paused while ${away} ${away.includes(",") ? "are" : "is"} away, so reminders are off until everyone is back.`,
        allowed_mentions: { parse: [] },
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

async function prepareGameover(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  gameName: string,
): Promise<void> {
  if (!interaction.guild_id) {
    await editOriginal(interaction, config, {
      content: "Use `/pbem-gameover` in a server.",
    });
    return;
  }
  const snapshot = await openRepository(config.databaseUrl)
    .getActiveGameByNameInGuild(interaction.guild_id, gameName);
  if (!snapshot) {
    await editOriginal(interaction, config, {
      content: "That game is not active in this server.",
      components: [],
    });
    return;
  }
  await editOriginal(interaction, config, {
    content: `Are you sure you want to end **${snapshot.game.name.replaceAll("@", "@\u200b")}**? Would you like to start a rematch first? Run \`/pbem-rematch\` with this game and a new name, then return here. Otherwise, continue to choose the winner or cancel.`,
    ...gameoverConfirmation(snapshot.game.id),
    allowed_mentions: { parse: [] },
  });
}

async function processGameoverConfirmation(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  gameId: string,
): Promise<void> {
  const guildId = interaction.guild_id;
  const snapshot = await openRepository(config.databaseUrl).getSnapshot(gameId);
  if (!guildId || !snapshot || snapshot.game.guildId !== guildId || snapshot.game.status !== "active") {
    await editOriginal(interaction, config, {
      content: "That game is no longer active. Run `/pbem-gameover` again.",
      components: [],
    });
    return;
  }
  await editOriginal(interaction, config, {
    content: `Choose the winning player or team for **${snapshot.game.name.replaceAll("@", "@\u200b")}**. This archives the game and removes its active board.`,
    ...gameWinnerPicker(snapshot),
    allowed_mentions: { parse: [] },
  });
}

async function processGameoverSelection(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  gameId: string,
): Promise<void> {
  const guildId = interaction.guild_id;
  const actorId = interactionUserId(interaction);
  const winnerUserId = interaction.data?.values?.[0];
  if (!guildId || !actorId || !winnerUserId) {
    throw new Error("Game completion is missing server, user, or winner context.");
  }
  const archived = await openRepository(config.databaseUrl)
    .completeGame(gameId, guildId, winnerUserId, actorId);
  if (!archived) {
    await editOriginal(interaction, config, {
      content: "That game or winning player is no longer available. Run `/pbem-gameover` again.",
      components: [],
    });
    return;
  }

  const winner = archived.players.find((player) => player.userId === winnerUserId);
  if (!winner) throw new Error("The archived game does not contain its selected winner.");
  if (archived.messageId) {
    try {
      await deleteChannelMessage(archived.channelId, archived.messageId, config.botToken);
    } catch (error) {
      console.error("Could not remove the completed PBEM game board:", error);
    }
  }

  const winnerUserIds = winner.notificationUserIds ?? [winner.userId];
  const mentions = winnerUserIds.map((userId) => `<@${userId}>`).join(" ");
  try {
    await postChannelMessage(archived.channelId, config.botToken, {
      content: `Congratulations to **${winner.username.replaceAll("@", "@\u200b")}**${mentions ? ` (${mentions})` : ""} for winning **${archived.name.replaceAll("@", "@\u200b")}**!`,
      allowed_mentions: { users: winnerUserIds },
    });
  } catch (error) {
    console.error("The game was archived but the congratulations message could not be sent:", error);
    await editOriginal(interaction, config, {
      content: `The game was archived, but I couldn't post the congratulations message. Check the bot's channel permissions.`,
      components: [],
    });
    return;
  }

  await editOriginal(interaction, config, {
    content: `**${archived.name.replaceAll("@", "@\u200b")}** has been archived.`,
    components: [],
    allowed_mentions: { parse: [] },
  });
}

async function processGameRematch(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  sourceName: string,
  rematchName: string,
): Promise<void> {
  const guildId = interaction.guild_id;
  const creatorId = interactionUserId(interaction);
  if (!guildId || !creatorId) {
    await editOriginal(interaction, config, {
      content: "Use `/pbem-rematch` in a server.",
    });
    return;
  }

  const repository = openRepository(config.databaseUrl);
  const source = await repository.getActiveGameByNameInGuild(guildId, sourceName);
  if (!source) {
    await editOriginal(interaction, config, {
      content: "That game is not active in this server.",
    });
    return;
  }

  let gameId: string | undefined;
  let boardMessageId: string | undefined;
  let gameActivated = false;
  try {
    const players: SelectedPlayer[] = source.players.map((player) => ({
      userId: player.userId,
      username: player.username,
      ...(player.notificationUserIds
        ? { notificationUserIds: player.notificationUserIds }
        : {}),
      ...(player.notificationUsernames
        ? { notificationUsernames: player.notificationUsernames }
        : {}),
    }));
    gameId = await repository.createDraft({
      name: rematchName,
      mode: source.game.mode,
      activeMode: source.game.activeMode,
      reminderDays: source.game.reminderDays,
      guildId,
      channelId: source.game.channelId,
      createdBy: creatorId,
    });
    const draft = await repository.claimDraft(gameId, creatorId);
    if (!draft) throw new Error("The rematch setup could not be claimed.");

    const now = new Date().toISOString();
    const initialSnapshot: GameSnapshot = {
      game: { ...draft.game, activeMode: source.game.activeMode, status: "active" },
      players: createInitialPlayers(players, source.game.activeMode, now),
      away: await repository.getAwayMap(
        guildId,
        players.flatMap((player) => [
          player.userId,
          ...(player.notificationUserIds ?? []),
        ]),
      ),
    };
    const board = await postChannelMessage(
      source.game.channelId,
      config.botToken,
      buildGameBoard(initialSnapshot, true),
    );
    boardMessageId = board.id;
    const snapshot = await repository.activateGame(gameId, players, board.id);
    gameActivated = true;
    await editOriginal(interaction, config, {
      content: `Started **${snapshot.game.name.replaceAll("@", "@\u200b")}** with the same players and teams as **${source.game.name.replaceAll("@", "@\u200b")}**.`,
      components: [],
      allowed_mentions: { parse: [] },
    });
  } catch (error) {
    if (!(error instanceof GameNameInUseError)) {
      console.error("Could not start PBEM rematch:", error);
    }
    if (gameActivated) return;
    if (boardMessageId) {
      try {
        await deleteChannelMessage(source.game.channelId, boardMessageId, config.botToken);
      } catch (deleteError) {
        console.error("Could not remove the incomplete rematch board:", deleteError);
      }
    }
    if (gameId) {
      try {
        await repository.deleteDraft(gameId);
      } catch (deleteError) {
        console.error("Could not remove the incomplete rematch:", deleteError);
      }
    }
    await editOriginal(interaction, config, {
      content: error instanceof GameNameInUseError
        ? "A game with that name already exists on this server. Choose a different name."
        : "The rematch could not be started. Please try `/pbem-rematch` again.",
    });
  }
}

async function autocompleteActiveGame(
  interaction: InteractionPayload,
  config: RuntimeConfig,
): Promise<Response> {
  const focusedOption = interaction.data?.options?.find((option) => option.focused);
  if (
    ![
      "pbem-delete",
      "pbem-reminders",
      "pbem-remind",
      "pbem-status",
      "pbem-teams",
      "pbem-players",
      "pbem-gameover",
      "pbem-rematch",
    ].includes(interaction.data?.name ?? "") ||
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

async function processGameStatus(
  interaction: InteractionPayload,
  config: RuntimeConfig,
  gameName: string,
): Promise<void> {
  const snapshot = interaction.guild_id
    ? await openRepository(config.databaseUrl)
      .getActiveGameByNameInGuild(interaction.guild_id, gameName)
    : null;
  if (!snapshot) {
    await editOriginal(interaction, config, {
      content: "That game is not active in this server.",
    });
    return;
  }

  await editOriginal(interaction, config, {
    embeds: [buildGameStatusEmbed(snapshot)],
    allowed_mentions: { parse: [] },
  });
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

    if (commandName === "pbem-players") {
      const gameName = optionValue(interaction, "game")?.trim();
      const action = optionValue(interaction, "action");
      if (!gameName || gameName.length > 80 || (action !== "add" && action !== "remove")) {
        return immediateResponse(4, {
          content: "Choose an active game and select whether to add or remove players.",
          flags: EPHEMERAL,
        });
      }
      if (!interaction.guild_id) {
        return immediateResponse(4, {
          content: "Use `/pbem-players` in a server.",
          flags: EPHEMERAL,
        });
      }
      const task = preparePlayerManagement(interaction, config, gameName, action);
      return scheduledResponse(5, { flags: EPHEMERAL }, task, schedule, interaction, config);
    }

    if (commandName === "pbem-teams") {
      const gameName = optionValue(interaction, "game")?.trim();
      const action = optionValue(interaction, "action");
      if (!gameName || gameName.length > 80 || (action !== "add" && action !== "remove")) {
        return immediateResponse(4, {
          content: "Choose an active game and select whether to add or remove a shared team.",
          flags: EPHEMERAL,
        });
      }
      if (!interaction.guild_id) {
        return immediateResponse(4, {
          content: "Use `/pbem-teams` in a server.",
          flags: EPHEMERAL,
        });
      }
      const task = prepareTeamManagement(interaction, config, gameName, action);
      return scheduledResponse(5, { flags: EPHEMERAL }, task, schedule, interaction, config);
    }

    if (commandName === "pbem-gameover") {
      const gameName = optionValue(interaction, "game")?.trim();
      if (!gameName || gameName.length > 80 || !interaction.guild_id) {
        return immediateResponse(4, {
          content: "Choose an active game and use `/pbem-gameover` in a server.",
          flags: EPHEMERAL,
        });
      }
      const task = prepareGameover(interaction, config, gameName);
      return scheduledResponse(5, { flags: EPHEMERAL }, task, schedule, interaction, config);
    }

    if (commandName === "pbem-rematch") {
      const gameName = optionValue(interaction, "game")?.trim();
      const rematchName = optionValue(interaction, "name")?.trim();
      if (
        !gameName ||
        gameName.length > 80 ||
        !rematchName ||
        rematchName.length > 80 ||
        !interaction.guild_id
      ) {
        return immediateResponse(4, {
          content: "Choose an active game, provide a new name of 1-80 characters, and use `/pbem-rematch` in a server.",
          flags: EPHEMERAL,
        });
      }
      const task = processGameRematch(interaction, config, gameName, rematchName);
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

    if (commandName === "pbem-status") {
      const gameName = optionValue(interaction, "game")?.trim();
      if (!gameName || gameName.length > 80 || !interaction.guild_id) {
        return immediateResponse(4, {
          content: "Choose an active game and use `/pbem-status` in a server.",
          flags: EPHEMERAL,
        });
      }
      const task = processGameStatus(interaction, config, gameName);
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

    if (commandName === "pbem-away" || commandName === "pbem-back") {
      if (!interaction.guild_id) {
        return immediateResponse(4, {
          content: `Use \`/${commandName}\` in a server.`,
          flags: EPHEMERAL,
        });
      }
      const task = commandName === "pbem-away"
        ? processAway(interaction, config)
        : processBack(interaction, config);
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
      try {
        await reportInteractionError(error, interaction, config);
      } catch (reportError) {
        console.error("Could not send the interaction failure report:", reportError);
      }
      return immediateResponse(8, { choices: [] });
    }
  }

  if (interaction.type === 3) {
    const customId = interaction.data?.custom_id ?? "";
    if (customId.startsWith("pbem:gameover-confirm:")) {
      const gameId = customId.slice("pbem:gameover-confirm:".length);
      if (!gameId || interaction.data?.component_type !== 2) {
        return immediateResponse(4, {
          content: "This game-over confirmation is invalid.",
          flags: EPHEMERAL,
        });
      }
      const task = processGameoverConfirmation(interaction, config, gameId);
      return scheduledResponse(6, undefined, task, schedule, interaction, config);
    }
    if (customId.startsWith("pbem:gameover-cancel:")) {
      const gameId = customId.slice("pbem:gameover-cancel:".length);
      if (!gameId || interaction.data?.component_type !== 2) {
        return immediateResponse(4, {
          content: "This game-over cancellation is invalid.",
          flags: EPHEMERAL,
        });
      }
      return immediateResponse(7, {
        content: "Game over cancelled.",
        components: [],
      });
    }
    if (customId.startsWith("pbem:gameover:")) {
      const [, action, gameId] = customId.split(":");
      if (action !== "gameover" || !gameId || interaction.data?.component_type !== 3) {
        return immediateResponse(4, {
          content: "This winner selection is invalid.",
          flags: EPHEMERAL,
        });
      }
      const task = processGameoverSelection(interaction, config, gameId);
      return scheduledResponse(6, undefined, task, schedule, interaction, config);
    }
    if (customId.startsWith("pbem:teams:")) {
      const [, , action, gameId] = customId.split(":");
      if (
        !gameId ||
        (action !== "add" && action !== "remove") ||
        (action === "add" && interaction.data?.component_type !== 5) ||
        (action === "remove" && interaction.data?.component_type !== 3)
      ) {
        return immediateResponse(4, {
          content: "This shared-team selection is invalid.",
          flags: EPHEMERAL,
        });
      }
      const task = processTeamManagementSelection(interaction, config, action, gameId);
      return scheduledResponse(6, undefined, task, schedule, interaction, config);
    }
    if (customId.startsWith("pbem:players:")) {
      const [, , action, gameId] = customId.split(":");
      if (
        !gameId ||
        (action !== "add" && action !== "remove") ||
        (action === "add" && interaction.data?.component_type !== 5) ||
        (action === "remove" && interaction.data?.component_type !== 3)
      ) {
        return immediateResponse(4, {
          content: "This player selection is invalid.",
          flags: EPHEMERAL,
        });
      }
      const task = processPlayerManagementSelection(interaction, config, action, gameId);
      return scheduledResponse(6, undefined, task, schedule, interaction, config);
    }
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
    if (!gameId || (action !== "player" && action !== "away" && action !== "mode")) {
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
        await reportInteractionError(error, interaction, config);
      } catch (reportError) {
        console.error("Could not send the interaction failure report:", reportError);
      }
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

  if (interaction.type === 2 && interaction.data?.name === "pbem-nodb") {
    await prepareNoDbGame(interaction, config);
    return;
  }
  if (interaction.type === 3 && interaction.data?.custom_id?.startsWith("pbem:nodb:")) {
    const action = interaction.data.custom_id.split(":")[2];
    if (action === "select") {
      await finishNoDbGameSetup(interaction, config);
    } else if (action === "player" || action === "mode") {
      await processNoDbBoardButton(interaction, config);
    } else {
      throw new Error("Unsupported no-database board interaction.");
    }
    return;
  }

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
    try {
      await reportInteractionError(error, interaction, config);
    } catch (reportError) {
      console.error("Could not send the interaction failure report:", reportError);
    }
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

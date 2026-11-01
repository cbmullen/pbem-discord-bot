import { selectPlayer, switchMode } from "../game/turns.js";
import type { ActiveMode, GameMode, GameSnapshot, Player } from "../game/types.js";
import { buildGameBoard } from "./game-board.js";
import type { DiscordMessagePayload } from "./game-board.js";

export interface NoDbDiscordMessage {
  content: string;
  components: Array<{
    type: number;
    components?: Array<{
      type: number;
      custom_id?: string;
      label?: string;
      style?: number;
      disabled?: boolean;
    }>;
  }>;
}

export interface NoDbBoardState {
  gameId: string;
  mode: GameMode;
  activeMode: ActiveMode;
  players: Player[];
  revision: number;
}

export interface NoDbBoardUpdate {
  content: string;
  components: NoDbDiscordMessage["components"];
}

const NO_DB_NOTICE = "_No database: this board is the only saved copy._";

function playerId(
  gameId: string,
  player: Player,
  activeMode: ActiveMode,
  revision: number,
): string {
  const pendingSince = player.pendingSince
    ? Math.floor(Date.parse(player.pendingSince) / 1000).toString(36)
    : "-";
  return `pbem:nodb:player:${gameId}:${player.userId}:${player.status === "pending" ? "p" : "d"}:${pendingSince}:${revision.toString(36)}:${activeMode === "consecutive" ? "c" : "s"}`;
}

function modeId(gameId: string, activeMode: ActiveMode, revision: number): string {
  return `pbem:nodb:mode:${gameId}:${revision.toString(36)}:${activeMode === "consecutive" ? "c" : "s"}`;
}

export function buildNoDbGameBoard(
  snapshot: GameSnapshot,
  announcePending = false,
  revision = 0,
): DiscordMessagePayload {
  const board = buildGameBoard(snapshot, announcePending);
  return {
    ...board,
    content: board.content.replace("\nPending:", `\n${NO_DB_NOTICE}\nPending:`),
    components: board.components.map((row) => ({
      ...row,
      components: row.components.map((button) => {
        const parts = button.custom_id.split(":");
        const player = snapshot.players.find(({ userId }) => userId === parts[3]);
        if (parts[1] === "player" && player) {
          return {
            ...button,
            custom_id: playerId(snapshot.game.id, player, snapshot.game.activeMode, revision),
          };
        }
        if (parts[1] === "mode") {
          return {
            ...button,
            custom_id: modeId(snapshot.game.id, snapshot.game.activeMode, revision),
          };
        }
        return button;
      }),
    })),
  };
}

export function readNoDbBoardState(message: NoDbDiscordMessage): NoDbBoardState {
  if (!message.content.includes(NO_DB_NOTICE)) {
    throw new Error("This is not a no-database game board.");
  }
  const buttons = message.components.flatMap((row) => row.components ?? []);
  const playerButtons = buttons.filter((button) =>
    button.custom_id?.startsWith("pbem:nodb:player:"),
  );
  const modeButton = buttons.find((button) =>
    button.custom_id?.startsWith("pbem:nodb:mode:"),
  );
  if (playerButtons.length === 0 || playerButtons.length > 25) {
    throw new Error("The no-database board has an invalid player roster.");
  }

  let gameId: string | undefined;
  let revision: number | undefined;
  let activeMode: ActiveMode | undefined;
  const players = playerButtons.map((button, position): Player => {
    const parts = button.custom_id!.split(":");
    if (parts.length !== 9) throw new Error("The no-database board has an invalid player button.");
    const [, , , buttonGameId, userId, statusCode, pendingValue, revisionValue, modeCode] = parts;
    if (!buttonGameId || !userId || !revisionValue || !modeCode) {
      throw new Error("The no-database board has incomplete player state.");
    }
    const buttonRevision = Number.parseInt(revisionValue, 36);
    if (!Number.isSafeInteger(buttonRevision) || buttonRevision < 0) {
      throw new Error("The no-database board has an invalid revision.");
    }
    const buttonMode = modeCode === "c"
      ? "consecutive"
      : modeCode === "s" ? "simultaneous" : null;
    if (
      !buttonMode ||
      (statusCode !== "p" && statusCode !== "d") ||
      (gameId !== undefined && buttonGameId !== gameId) ||
      (revision !== undefined && buttonRevision !== revision) ||
      (activeMode !== undefined && buttonMode !== activeMode)
    ) {
      throw new Error("The no-database board contains inconsistent player state.");
    }
    gameId = buttonGameId;
    revision = buttonRevision;
    activeMode = buttonMode;

    const label = button.label?.match(/^(.*) - (pending|done)$/);
    if (!label?.[1]) throw new Error("The no-database board has an invalid player label.");
    const status = statusCode === "p" ? "pending" : "done";
    if (label[2] !== status) throw new Error("The player label does not match its saved state.");
    let pendingSince: string | null = null;
    if (pendingValue !== "-") {
      const seconds = Number.parseInt(pendingValue!, 36);
      if (!Number.isSafeInteger(seconds) || seconds < 0) {
        throw new Error("The no-database board has an invalid pending timestamp.");
      }
      pendingSince = new Date(seconds * 1000).toISOString();
    }
    if ((status === "pending") !== (pendingSince !== null)) {
      throw new Error("The no-database board has inconsistent pending state.");
    }
    return {
      userId,
      username: label[1],
      position,
      status,
      pendingSince,
      lastUpdatedAt: pendingSince ?? new Date(0).toISOString(),
    };
  });

  if (!gameId || revision === undefined || !activeMode) {
    throw new Error("The no-database board has incomplete state.");
  }
  if (new Set(players.map(({ userId }) => userId)).size !== players.length) {
    throw new Error("The no-database board has duplicate players.");
  }
  if (modeButton) {
    const parts = modeButton.custom_id!.split(":");
    if (
      parts.length !== 6 ||
      parts[3] !== gameId ||
      parts[4] !== revision.toString(36) ||
      parts[5] !== (activeMode === "consecutive" ? "c" : "s")
    ) {
      throw new Error("The no-database board has inconsistent mode state.");
    }
  }

  return {
    gameId,
    mode: modeButton ? "both" : activeMode,
    activeMode,
    players,
    revision,
  };
}

export function updateNoDbGameBoard(
  message: NoDbDiscordMessage,
  customId: string,
  now = new Date(),
): NoDbBoardUpdate {
  const state = readNoDbBoardState(message);
  const buttons = message.components.flatMap((row) => row.components ?? []);
  if (!buttons.some((button) => button.custom_id === customId)) {
    throw new Error("This no-database board has changed; click a current button.");
  }
  const parts = customId.split(":");
  if (parts[3] !== state.gameId) {
    throw new Error("The button does not match this no-database board.");
  }

  const transition = parts[2] === "mode"
    ? switchMode(state, now.toISOString())
    : parts[2] === "player"
      ? selectPlayer(state, parts[4] ?? "", now.toISOString())
      : null;
  if (!transition) throw new Error("This no-database board button is invalid.");

  const nextRevision = state.revision + 1;
  const playersById = new Map(transition.state.players.map((player) => [player.userId, player]));
  const components = message.components.map((row) => ({
    ...row,
    components: row.components?.map((button) => {
      const buttonParts = button.custom_id?.split(":");
      if (buttonParts?.[2] === "player" && buttonParts[3] === state.gameId) {
        const player = playersById.get(buttonParts[4] ?? "");
        if (!player) throw new Error("The player roster changed on this board.");
        return {
          ...button,
          label: `${player.username} - ${player.status}`.slice(0, 80),
          style: player.status === "pending" ? 1 : 3,
          disabled:
            transition.state.activeMode === "consecutive" && player.status === "pending",
          custom_id: playerId(state.gameId, player, transition.state.activeMode, nextRevision),
        };
      }
      if (buttonParts?.[2] === "mode" && buttonParts[3] === state.gameId) {
        return {
          ...button,
          label: `Switch to ${transition.state.activeMode === "consecutive" ? "simultaneous" : "consecutive"}`,
          custom_id: modeId(state.gameId, transition.state.activeMode, nextRevision),
        };
      }
      return button;
    }),
  }));
  const pending = transition.state.players.filter((player) => player.status === "pending");
  const pendingLine = `Pending: ${pending.map((player) => `<@${player.userId}>`).join(", ") || "nobody"}`;
  const pendingIndex = message.content.lastIndexOf("\nPending:");
  if (pendingIndex < 0) throw new Error("The no-database board has no pending-player summary.");

  return {
    content: `${message.content.slice(0, pendingIndex)}\n${pendingLine}`,
    components,
  };
}

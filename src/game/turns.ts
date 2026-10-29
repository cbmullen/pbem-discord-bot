import type { ActiveMode, GameMode, Player, PlayerStatus } from "./types.js";

export interface TurnState {
  mode: GameMode;
  activeMode: ActiveMode;
  players: Player[];
}

export interface TurnTransition {
  state: TurnState;
  notifyUserIds: string[];
  eventType: "player_selected" | "player_marked_done" | "cycle_reset" | "mode_changed";
}

function updatePlayer(
  player: Player,
  status: PlayerStatus,
  now: string,
): Player {
  return {
    ...player,
    status,
    pendingSince: status === "pending" ? (player.status === "pending" ? player.pendingSince : now) : null,
    lastUpdatedAt: player.status === status ? player.lastUpdatedAt : now,
  };
}

export function createInitialPlayers(
  selected: Array<Pick<Player, "userId" | "username">>,
  mode: ActiveMode,
  now: string,
): Player[] {
  return selected.map((player, position) => {
    const status: PlayerStatus =
      mode === "simultaneous" || position === 0 ? "pending" : "done";
    return {
      ...player,
      position,
      status,
      pendingSince: status === "pending" ? now : null,
      lastUpdatedAt: now,
    };
  });
}

export function selectPlayer(
  state: TurnState,
  userId: string,
  now: string,
): TurnTransition {
  const selected = state.players.find((player) => player.userId === userId);
  if (!selected) {
    throw new Error("That user is not a player in this game.");
  }

  if (state.activeMode === "consecutive") {
    const changed = selected.status !== "pending";
    const players = state.players.map((player) =>
      updatePlayer(player, player.userId === userId ? "pending" : "done", now),
    );
    return {
      state: { ...state, players },
      notifyUserIds: changed ? [userId] : [],
      eventType: "player_selected",
    };
  }

  const selectedStatus: PlayerStatus =
    selected.status === "pending" ? "done" : "pending";
  let players = state.players.map((player) =>
    player.userId === userId ? updatePlayer(player, selectedStatus, now) : player,
  );
  let eventType: TurnTransition["eventType"] =
    selectedStatus === "done" ? "player_marked_done" : "player_selected";

  if (selectedStatus === "done" && players.every((player) => player.status === "done")) {
    players = players.map((player) => updatePlayer(player, "pending", now));
    eventType = "cycle_reset";
  }

  const pendingUsers = players
    .filter((player) => player.status === "pending")
    .map((player) => player.userId);

  return {
    state: { ...state, players },
    notifyUserIds: eventType === "cycle_reset" ? pendingUsers : [],
    eventType,
  };
}

export function switchMode(state: TurnState, now: string): TurnTransition {
  if (state.mode !== "both") {
    throw new Error("This game does not support switching modes.");
  }

  const activeMode: ActiveMode =
    state.activeMode === "consecutive" ? "simultaneous" : "consecutive";
  let players: Player[];

  if (activeMode === "simultaneous") {
    players = state.players.map((player) => updatePlayer(player, "pending", now));
  } else {
    const firstPending =
      state.players.find((player) => player.status === "pending") ??
      state.players[0];
    if (!firstPending) {
      throw new Error("Cannot switch modes for a game with no players.");
    }
    players = state.players.map((player) =>
      updatePlayer(player, player.userId === firstPending.userId ? "pending" : "done", now),
    );
  }

  return {
    state: { ...state, activeMode, players },
    notifyUserIds: players
      .filter((player) => player.status === "pending")
      .map((player) => player.userId),
    eventType: "mode_changed",
  };
}


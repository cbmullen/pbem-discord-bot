import type { GameMode, Player, SelectedPlayer } from "./types.js";

export interface PlayerRosterState {
  mode: GameMode;
  activeMode: Exclude<GameMode, "both">;
  players: Player[];
}

export class PlayerRosterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayerRosterError";
  }
}

export function addPlayers(
  state: PlayerRosterState,
  additions: SelectedPlayer[],
  now: string,
): Player[] {
  if (additions.length === 0) {
    throw new PlayerRosterError("Select at least one player to add.");
  }
  const maxPlayers = state.mode === "both" ? 24 : 25;
  if (state.players.length + additions.length > maxPlayers) {
    throw new PlayerRosterError(`This game supports up to ${maxPlayers} players.`);
  }
  const existing = new Set(state.players.map((player) => player.userId));
  const selected = new Set<string>();
  for (const player of additions) {
    if (existing.has(player.userId) || selected.has(player.userId)) {
      throw new PlayerRosterError(`${player.username} is already in this game.`);
    }
    selected.add(player.userId);
  }

  return [
    ...state.players,
    ...additions.map((player, index): Player => {
      const status = state.activeMode === "simultaneous" ? "pending" : "done";
      return {
        ...player,
        position: state.players.length + index,
        status,
        pendingSince: status === "pending" ? now : null,
        lastUpdatedAt: now,
      };
    }),
  ];
}

export function removePlayers(
  state: PlayerRosterState,
  userIds: string[],
  now: string,
): Player[] {
  if (userIds.length === 0) {
    throw new PlayerRosterError("Select at least one player to remove.");
  }
  if (new Set(userIds).size !== userIds.length) {
    throw new PlayerRosterError("The same player cannot be selected more than once.");
  }
  const selected = new Set(userIds);
  const playersById = new Map(state.players.map((player) => [player.userId, player]));
  const missing = userIds.find((userId) => !playersById.has(userId));
  if (missing) throw new PlayerRosterError("Only players in this game can be removed.");

  const remaining = state.players.filter((player) => !selected.has(player.userId));
  if (remaining.length === 0) {
    throw new PlayerRosterError("A game must have at least one player.");
  }

  const removedPending = state.players.find(
    (player) => player.status === "pending" && selected.has(player.userId),
  );
  let nextPendingId: string | undefined;
  if (state.activeMode === "consecutive" && removedPending) {
    nextPendingId =
      remaining.find((player) => player.position > removedPending.position)?.userId ??
      remaining[0]?.userId;
  }
  const resetSimultaneousRound =
    state.activeMode === "simultaneous" &&
    remaining.every((player) => player.status === "done");

  return remaining.map((player, position) => {
    if (nextPendingId) {
      const isNext = player.userId === nextPendingId;
      return {
        ...player,
        position,
        status: isNext ? "pending" : "done",
        pendingSince: isNext ? (player.pendingSince ?? now) : null,
        lastUpdatedAt: isNext && player.status !== "pending" ? now : player.lastUpdatedAt,
      };
    }
    if (resetSimultaneousRound) {
      return {
        ...player,
        position,
        status: "pending",
        pendingSince: now,
        lastUpdatedAt: now,
      };
    }
    return { ...player, position };
  });
}

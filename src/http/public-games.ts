import type {
  ArchivedGame,
  PublicArchiveStatistics,
  PublicGameStatus,
} from "../database/repository.js";
import type { Player } from "../game/types.js";

export type NamedPublicGame = Omit<PublicGameStatus, "guildId"> & {
  serverName: string;
};

export interface PublicCompletedGame {
  name: string;
  serverName: string;
  mode: ArchivedGame["mode"];
  activeMode: ArchivedGame["activeMode"];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  winner: string;
  playerCount: number;
  completedTurns: number;
  averageTurnDurationMs: number | null;
  recordedTurnEvents: number;
}

export interface PublicPlayerStatistics {
  username: string;
  gamesPlayed: number;
  wins: number;
  completedTurns: number;
  averageTurnDurationMs: number | null;
}

function playerMembers(player: Player): Array<{ userId: string; username: string }> {
  const ids = player.notificationUserIds;
  const usernames = player.notificationUsernames;
  if (!ids?.length) return [{ userId: player.userId, username: player.username }];
  return ids.map((userId, index) => ({
    userId,
    username: usernames?.[index] ?? player.username,
  }));
}

export function summarizePublicArchives(
  archives: ArchivedGame[],
  guildNames: Map<string, string>,
  statistics?: PublicArchiveStatistics,
): {
  completedGames: PublicCompletedGame[];
  playerStats: PublicPlayerStatistics[];
  totals: { completedGames: number; averageGameDurationMs: number | null };
} {
  const stats = new Map<string, {
    username: string;
    gamesPlayed: number;
    wins: number;
    completedTurns: number;
    totalTurnDurationMs: number;
  }>();
  const completedGames = archives.map((archive): PublicCompletedGame => {
    const winner = archive.players.find((player) => player.userId === archive.winnerUserId);
    if (!winner) throw new Error(`Archived game "${archive.name}" has no winner in its roster.`);
    const winnerMembers = playerMembers(winner);
    const durationMs = Math.max(
      0,
      Date.parse(archive.completedAt) - Date.parse(archive.createdAt),
    );
    const completedTurns = archive.players.reduce(
      (sum, player) => sum + (player.completedTurns ?? 0),
      0,
    );
    const totalTurnDurationMs = archive.players.reduce(
      (sum, player) => sum + (player.totalTurnDurationMs ?? 0),
      0,
    );
    if (!statistics) {
      for (const player of archive.players) {
        for (const member of playerMembers(player)) {
          const current = stats.get(member.userId) ?? {
            username: member.username,
            gamesPlayed: 0,
            wins: 0,
            completedTurns: 0,
            totalTurnDurationMs: 0,
          };
          current.gamesPlayed += 1;
          if (winnerMembers.some((winnerMember) => winnerMember.userId === member.userId)) {
            current.wins += 1;
          }
          current.completedTurns += player.completedTurns ?? 0;
          current.totalTurnDurationMs += player.totalTurnDurationMs ?? 0;
          stats.set(member.userId, current);
        }
      }
    }

    return {
      name: archive.name,
      serverName: guildNames.get(archive.guildId) ?? "Unavailable server",
      mode: archive.mode,
      activeMode: archive.activeMode,
      startedAt: archive.createdAt,
      completedAt: archive.completedAt,
      durationMs,
      winner: winner.username,
      playerCount: archive.players.length,
      completedTurns,
      averageTurnDurationMs: completedTurns > 0
        ? totalTurnDurationMs / completedTurns
        : null,
      recordedTurnEvents: archive.events.filter((event) =>
        event.type === "player_selected" ||
        event.type === "player_marked_done" ||
        event.type === "cycle_reset",
      ).length,
    };
  });
  const durations = completedGames.map((game) => game.durationMs);
  return {
    completedGames,
    playerStats: (statistics
      ? statistics.playerStats.map(({ username, gamesPlayed, wins, completedTurns, averageTurnDurationMs }) => ({
        username,
        gamesPlayed,
        wins,
        completedTurns,
        averageTurnDurationMs,
      }))
      : [...stats.values()]
        .map(({ username, gamesPlayed, wins, completedTurns, totalTurnDurationMs }) => ({
          username,
          gamesPlayed,
          wins,
          completedTurns,
          averageTurnDurationMs: completedTurns > 0
            ? totalTurnDurationMs / completedTurns
            : null,
        })))
      .sort((left, right) => right.wins - left.wins || left.username.localeCompare(right.username)),
    totals: statistics?.totals ?? {
      completedGames: completedGames.length,
      averageGameDurationMs: durations.length > 0
        ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length
        : null,
    },
  };
}

export function addServerNames(
  games: PublicGameStatus[],
  guildNames: Map<string, string>,
): NamedPublicGame[] {
  return games.map(({ guildId, ...game }) => ({
    ...game,
    serverName: guildNames.get(guildId) ?? "Unavailable server",
  }));
}

import { isGamePaused } from "./away.js";
import type { AwayMap, Player } from "./types.js";

export function getDueReminderPlayers(
  players: Player[],
  reminderDays: number,
  now: Date,
  away?: AwayMap,
): Player[] {
  if (reminderDays <= 0) return [];
  // While anyone in the game is away, nobody in it is reminded.
  if (isGamePaused(players, away, now)) return [];
  const threshold = now.getTime() - reminderDays * 24 * 60 * 60 * 1000;
  return players.filter((player) => {
    if (player.status !== "pending" || !player.pendingSince) return false;
    const pendingSince = Date.parse(player.pendingSince);
    return Number.isFinite(pendingSince) && pendingSince <= threshold;
  });
}

import type { Player } from "./types.js";

export function getDueReminderPlayers(
  players: Player[],
  reminderDays: number,
  now: Date,
): Player[] {
  if (reminderDays <= 0) return [];
  const threshold = now.getTime() - reminderDays * 24 * 60 * 60 * 1000;
  return players.filter((player) => {
    if (player.status !== "pending" || !player.pendingSince) return false;
    const pendingSince = Date.parse(player.pendingSince);
    return Number.isFinite(pendingSince) && pendingSince <= threshold;
  });
}

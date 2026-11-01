import { isGamePaused } from "./away.js";
import type { AwayMap, Player } from "./types.js";

export interface QuietHours {
  start: number;
  end: number;
  utcOffsetMinutes: number;
}

export function parseClockTime(value: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function parseUtcOffset(value: string): number | undefined {
  const match = /^([+-])(0\d|1[0-4]):([0-5]\d)$/.exec(value);
  if (!match) return undefined;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (minutes % 15 !== 0 || (hours === 14 && minutes !== 0)) return undefined;
  const offset = (hours * 60 + minutes) * (match[1] === "-" ? -1 : 1);
  return offset < -720 || offset > 840 ? undefined : offset;
}

export function isInQuietHours(now: Date, quietHours: QuietHours): boolean {
  const localTime = new Date(now.getTime() + quietHours.utcOffsetMinutes * 60_000);
  const minute = localTime.getUTCHours() * 60 + localTime.getUTCMinutes();
  return quietHours.start < quietHours.end
    ? minute >= quietHours.start && minute < quietHours.end
    : minute >= quietHours.start || minute < quietHours.end;
}

export function shouldSendScheduledReminder(
  delivery: "dm" | "channel" | "none",
  quietStart: number | null,
  quietEnd: number | null,
  utcOffsetMinutes: number | null,
  now: Date,
): boolean {
  if (delivery === "none") return false;
  if (quietStart === null || quietEnd === null || utcOffsetMinutes === null) return true;
  return !isInQuietHours(now, {
    start: quietStart,
    end: quietEnd,
    utcOffsetMinutes,
  });
}

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

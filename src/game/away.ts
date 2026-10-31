import type { AwayMap, Player } from "./types.js";

export const MAX_AWAY_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ParsedAwayUntil =
  | { ok: true; until: string }
  | { ok: false; error: string };

/**
 * Parses the `until` option. The player is back at 00:00 UTC on the given date,
 * so "until 2026-11-10" means they return on the 10th.
 */
export function parseAwayUntil(input: string, now: Date = new Date()): ParsedAwayUntil {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!match) {
    return { ok: false, error: "Enter the return date as YYYY-MM-DD, for example 2026-11-10." };
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { ok: false, error: "That is not a real calendar date. Use YYYY-MM-DD." };
  }
  if (date.getTime() <= now.getTime()) {
    return { ok: false, error: "The return date must be in the future." };
  }
  if (date.getTime() - now.getTime() > MAX_AWAY_DAYS * DAY_MS) {
    return { ok: false, error: `The return date must be within ${MAX_AWAY_DAYS} days.` };
  }
  return { ok: true, until: date.toISOString() };
}

export function isAwayActive(until: string | null, now: Date = new Date()): boolean {
  if (until === null) return true;
  const time = Date.parse(until);
  return Number.isFinite(time) && time > now.getTime();
}

/** Drops records whose return date has passed. */
export function activeAway(away: AwayMap | undefined, now: Date = new Date()): AwayMap {
  const active: AwayMap = {};
  for (const [userId, info] of Object.entries(away ?? {})) {
    if (isAwayActive(info.until, now)) active[userId] = info;
  }
  return active;
}

/** Players of this game who are currently away. */
export function awayPlayers(
  players: Player[],
  away: AwayMap | undefined,
  now: Date = new Date(),
): Player[] {
  const active = activeAway(away, now);
  return players.filter((player) => active[player.userId] !== undefined);
}

/** A game is paused whenever any of its players is away. */
export function isGamePaused(
  players: Player[],
  away: AwayMap | undefined,
  now: Date = new Date(),
): boolean {
  return awayPlayers(players, away, now).length > 0;
}

/** "10 Nov" (UTC), with the year added when it is not the current year. */
export function formatAwayDate(until: string, now: Date = new Date()): string {
  const date = new Date(until);
  if (!Number.isFinite(date.getTime())) return "an unknown date";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(date.getUTCFullYear() === now.getUTCFullYear() ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(date);
}

export function awayLabel(until: string | null, now: Date = new Date()): string {
  return until === null ? "Away (no return date)" : `Away until ${formatAwayDate(until, now)}`;
}

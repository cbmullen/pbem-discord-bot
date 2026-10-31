import { neon } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import {
  createInitialPlayers,
  selectPlayer,
  switchMode,
} from "../game/turns.js";
import { getDueReminderPlayers } from "../game/reminders.js";
import type {
  ActiveMode,
  AwayMap,
  Game,
  GameMode,
  GameSnapshot,
  Player,
  SelectedPlayer,
} from "../game/types.js";

interface GameRow {
  id: string;
  name: string;
  mode: GameMode;
  active_mode: ActiveMode;
  reminder_days: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  created_by: string;
  created_at: string;
  status: "setup" | "creating" | "active";
  players: Player[] | string;
  events: Array<Record<string, unknown>> | string;
  version: number;
}

export interface NewGame {
  name: string;
  mode: GameMode;
  reminderDays: number;
  guildId: string;
  channelId: string;
  createdBy: string;
}

export interface DueReminder {
  gameId: string;
  gameName: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  userId: string;
  username: string;
  pendingSince: string;
  reminderDays: number;
}

export interface PublicGameStatus {
  guildId: string;
  name: string;
  mode: GameMode;
  activeMode: ActiveMode;
  reminderDays: number;
  createdAt: string;
  players: Array<{
    username: string;
    status: Player["status"];
    pendingSince: string | null;
  }>;
}

interface AwayRow {
  guild_id: string;
  user_id: string;
  until: string | Date | null;
}

function toIsoOrNull(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function groupAwayRows(rows: AwayRow[]): Map<string, AwayMap> {
  const byGuild = new Map<string, AwayMap>();
  for (const row of rows) {
    const guildAway = byGuild.get(row.guild_id) ?? {};
    guildAway[row.user_id] = { until: toIsoOrNull(row.until) };
    byGuild.set(row.guild_id, guildAway);
  }
  return byGuild;
}

export interface TransitionResult extends GameSnapshot {
  eventType: string;
}

export class GameNameInUseError extends Error {
  constructor() {
    super("A game with that name already exists on this server.");
    this.name = "GameNameInUseError";
  }
}

export function isGameNameConstraintViolation(error: unknown): boolean {
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    !("constraint" in error)
  ) {
    return false;
  }
  return (
    error.code === "23505" &&
    (error.constraint === "pbem_unique_game_name_per_server" ||
      error.constraint === "pbem_unique_game_name_per_channel")
  );
}

export async function listPublicActiveGames(
  databaseUrl: string,
): Promise<PublicGameStatus[]> {
  return openRepository(databaseUrl).listPublicGames();
}

function parseJson<T>(value: T | string): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function mapSnapshot(row: GameRow): GameSnapshot {
  const game: Game = {
    id: row.id,
    name: row.name,
    mode: row.mode,
    activeMode: row.active_mode,
    reminderDays: row.reminder_days,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    status: row.status === "active" ? "active" : "setup",
  };
  return { game, players: parseJson<Player[]>(row.players) };
}

export function openRepository(databaseUrl: string) {
  const sql = neon(databaseUrl);
  async function getRow(gameId: string): Promise<GameRow | undefined> {
    const rows = (await sql`
      SELECT * FROM pbem_games WHERE id = ${gameId} LIMIT 1
    `) as GameRow[];
    return rows[0];
  }

  // Away records are per server, not per game. Rows whose return date has
  // passed are ignored here and swept up by the daily cron job.
  async function loadAway(
    guildIds: string[],
    now = new Date(),
  ): Promise<Map<string, AwayMap>> {
    if (guildIds.length === 0) return new Map();
    const rows = (await sql`
      SELECT guild_id, user_id, until FROM pbem_away
      WHERE guild_id = ANY(${guildIds}::text[])
        AND (until IS NULL OR until > ${now.toISOString()})
    `) as AwayRow[];
    return groupAwayRows(rows);
  }

  async function withAway(snapshots: GameSnapshot[]): Promise<GameSnapshot[]> {
    const byGuild = await loadAway([
      ...new Set(snapshots.map(({ game }) => game.guildId)),
    ]);
    return snapshots.map((snapshot) => ({
      ...snapshot,
      away: byGuild.get(snapshot.game.guildId) ?? {},
    }));
  }

  const repository = {
    async claimInteraction(interactionId: string): Promise<boolean> {
      const rows = (await sql`
        WITH expired AS (
          DELETE FROM pbem_processed_interactions
          WHERE created_at < NOW() - INTERVAL '1 day'
          RETURNING interaction_id
        )
        INSERT INTO pbem_processed_interactions (interaction_id)
        VALUES (${interactionId})
        ON CONFLICT (interaction_id) DO NOTHING
        RETURNING interaction_id
      `) as Array<{ interaction_id: string }>;
      return rows.length > 0;
    },

    async createDraft(input: NewGame, now = new Date().toISOString()) {
      await sql`
        DELETE FROM pbem_games
        WHERE status <> 'active' AND created_at < NOW() - INTERVAL '24 hours'
      `;
      const id = randomUUID();
      const activeMode: ActiveMode =
        input.mode === "both" ? "consecutive" : input.mode;
      try {
        await sql`
          INSERT INTO pbem_games (
            id, name, mode, active_mode, reminder_days, guild_id, channel_id,
            created_by, created_at, status, events
          ) VALUES (
            ${id}, ${input.name}, ${input.mode}, ${activeMode}, ${input.reminderDays},
            ${input.guildId}, ${input.channelId}, ${input.createdBy}, ${now}, 'setup',
            ${JSON.stringify([{ type: "game_created", actorId: input.createdBy, createdAt: now }])}::jsonb
          )
        `;
      } catch (error) {
        if (isGameNameConstraintViolation(error)) throw new GameNameInUseError();
        throw error;
      }
      return id;
    },

    async deleteDraft(gameId: string) {
      await sql`
        DELETE FROM pbem_games
        WHERE id = ${gameId} AND status IN ('setup', 'creating')
      `;
    },

    async getSnapshot(gameId: string): Promise<GameSnapshot | null> {
      const row = await getRow(gameId);
      return row ? (await withAway([mapSnapshot(row)]))[0]! : null;
    },

    async getAwayMap(guildId: string, userIds: string[]): Promise<AwayMap> {
      const guildAway = (await loadAway([guildId])).get(guildId) ?? {};
      return Object.fromEntries(
        Object.entries(guildAway).filter(([userId]) => userIds.includes(userId)),
      );
    },

    async setAway(
      guildId: string,
      userId: string,
      until: string | null,
      setBy: string,
    ): Promise<void> {
      await sql`
        INSERT INTO pbem_away (guild_id, user_id, until, set_by, set_at)
        VALUES (${guildId}, ${userId}, ${until}, ${setBy}, NOW())
        ON CONFLICT (guild_id, user_id)
        DO UPDATE SET until = EXCLUDED.until,
                      set_by = EXCLUDED.set_by,
                      set_at = NOW()
      `;
    },

    /** Returns true when the player really was away (an expired record does not count). */
    async clearAway(guildId: string, userId: string): Promise<boolean> {
      const rows = (await sql`
        DELETE FROM pbem_away
        WHERE guild_id = ${guildId} AND user_id = ${userId}
        RETURNING (until IS NULL OR until > NOW()) AS was_away
      `) as Array<{ was_away: boolean }>;
      return rows[0]?.was_away === true;
    },

    /** Deletes records whose return date has passed and says who they belonged to. */
    async sweepExpiredAway(): Promise<Array<{ guildId: string; userId: string }>> {
      const rows = (await sql`
        DELETE FROM pbem_away
        WHERE until IS NOT NULL AND until <= NOW()
        RETURNING guild_id, user_id
      `) as Array<{ guild_id: string; user_id: string }>;
      return rows.map((row) => ({ guildId: row.guild_id, userId: row.user_id }));
    },

    async listActiveGamesForPlayer(
      guildId: string,
      userId: string,
    ): Promise<GameSnapshot[]> {
      const rows = (await sql`
        SELECT * FROM pbem_games
        WHERE guild_id = ${guildId}
          AND status = 'active'
          AND players @> ${JSON.stringify([{ userId }])}::jsonb
        ORDER BY lower(name), created_at
      `) as GameRow[];
      return withAway(rows.map(mapSnapshot));
    },

    async listDueReminders(now = new Date()): Promise<DueReminder[]> {
      const rows = (await sql`
        SELECT * FROM pbem_games
        WHERE status = 'active' AND reminder_days > 0
      `) as GameRow[];
      const awayByGuild = await loadAway(
        [...new Set(rows.map((row) => row.guild_id))],
        now,
      );
      return rows.flatMap((row) => {
        const snapshot = mapSnapshot(row);
        return getDueReminderPlayers(
          snapshot.players,
          snapshot.game.reminderDays,
          now,
          awayByGuild.get(snapshot.game.guildId),
        ).map((player) => ({
          gameId: snapshot.game.id,
          gameName: snapshot.game.name,
          guildId: snapshot.game.guildId,
          channelId: snapshot.game.channelId,
          messageId: snapshot.game.messageId,
          userId: player.userId,
          username: player.username,
          pendingSince: player.pendingSince!,
          reminderDays: snapshot.game.reminderDays,
        }));
      });
    },

    async claimReminderDelivery(reminder: DueReminder): Promise<boolean> {
      const rows = (await sql`
        INSERT INTO pbem_reminder_deliveries (
          game_id, user_id, pending_since, claimed_at
        )
        SELECT game.id, ${reminder.userId}, ${reminder.pendingSince},
               NOW()
        FROM pbem_games AS game
        WHERE game.id = ${reminder.gameId}
          AND game.status = 'active'
          AND game.reminder_days > 0
          AND NOT EXISTS (
            SELECT 1 FROM pbem_away AS away
            WHERE away.guild_id = game.guild_id
              AND (away.until IS NULL OR away.until > NOW())
              AND game.players @> jsonb_build_array(
                jsonb_build_object('userId', away.user_id)
              )
          )
          AND game.players @> ${JSON.stringify([{
            userId: reminder.userId,
            status: "pending",
            pendingSince: reminder.pendingSince,
          }])}::jsonb
        ON CONFLICT (game_id, user_id, pending_since)
        DO UPDATE SET claimed_at = NOW()
        WHERE pbem_reminder_deliveries.sent_at IS NULL
          AND pbem_reminder_deliveries.claimed_at < NOW() - INTERVAL '1 hour'
        RETURNING game_id
      `) as Array<{ game_id: string }>;
      return rows.length > 0;
    },

    async markReminderSent(reminder: DueReminder): Promise<void> {
      await sql`
        UPDATE pbem_reminder_deliveries
        SET sent_at = NOW()
        WHERE game_id = ${reminder.gameId}
          AND user_id = ${reminder.userId}
          AND pending_since = ${reminder.pendingSince}
          AND sent_at IS NULL
      `;
    },

    async releaseReminderClaim(reminder: DueReminder): Promise<void> {
      await sql`
        DELETE FROM pbem_reminder_deliveries
        WHERE game_id = ${reminder.gameId}
          AND user_id = ${reminder.userId}
          AND pending_since = ${reminder.pendingSince}
          AND sent_at IS NULL
      `;
    },

    async listPublicGames(): Promise<PublicGameStatus[]> {
      const rows = (await sql`
        SELECT guild_id, name, mode, active_mode, reminder_days, created_at, players
        FROM pbem_games
        WHERE status = 'active'
        ORDER BY lower(name), created_at
      `) as Array<{
        guild_id: string;
        name: string;
        mode: GameMode;
        active_mode: ActiveMode;
        reminder_days: number;
        created_at: string;
        players: Player[] | string;
      }>;
      return rows.map((row) => ({
        guildId: row.guild_id,
        name: row.name,
        mode: row.mode,
        activeMode: row.active_mode,
        reminderDays: row.reminder_days,
        createdAt: row.created_at,
        players: parseJson<Player[]>(row.players).map((player) => ({
          username: player.username,
          status: player.status,
          pendingSince: player.pendingSince,
        })),
      }));
    },

    async replaceBoardMessageId(
      gameId: string,
      previousMessageId: string,
      nextMessageId: string,
    ): Promise<boolean> {
      const rows = (await sql`
        UPDATE pbem_games
        SET message_id = ${nextMessageId}, version = version + 1
        WHERE id = ${gameId} AND status = 'active'
          AND message_id = ${previousMessageId}
        RETURNING id
      `) as Array<{ id: string }>;
      return rows.length > 0;
    },

    async getActiveGameByNameInGuild(
      guildId: string,
      name: string,
    ): Promise<GameSnapshot | null> {
      const rows = (await sql`
        SELECT * FROM pbem_games
        WHERE guild_id = ${guildId}
          AND status = 'active' AND lower(name) = lower(${name.trim()})
        LIMIT 1
      `) as GameRow[];
      return rows[0] ? (await withAway([mapSnapshot(rows[0])]))[0]! : null;
    },

    async updateActiveGameReminderDays(
      guildId: string,
      name: string,
      reminderDays: number,
    ): Promise<GameSnapshot | null> {
      const rows = (await sql`
        UPDATE pbem_games
        SET reminder_days = ${reminderDays}, version = version + 1
        WHERE guild_id = ${guildId}
          AND status = 'active' AND lower(name) = lower(${name.trim()})
        RETURNING *
      `) as GameRow[];
      return rows[0] ? mapSnapshot(rows[0]) : null;
    },

    async deleteActiveGame(gameId: string, guildId: string): Promise<GameSnapshot | null> {
      const rows = (await sql`
        DELETE FROM pbem_games
        WHERE id = ${gameId} AND guild_id = ${guildId} AND status = 'active'
        RETURNING *
      `) as GameRow[];
      return rows[0] ? mapSnapshot(rows[0]) : null;
    },

    async listActiveGamesInGuild(guildId: string): Promise<GameSnapshot[]> {
      const rows = (await sql`
        SELECT * FROM pbem_games
        WHERE guild_id = ${guildId} AND status = 'active'
        ORDER BY lower(name), created_at
      `) as GameRow[];
      return withAway(rows.map(mapSnapshot));
    },

    async listGamesInGuild(guildId: string): Promise<GameSnapshot[]> {
      const rows = (await sql`
        SELECT * FROM pbem_games
        WHERE guild_id = ${guildId}
        ORDER BY lower(name), created_at
      `) as GameRow[];
      return rows.map(mapSnapshot);
    },

    async deleteAllGamesInGuild(guildId: string): Promise<GameSnapshot[]> {
      const rows = (await sql`
        DELETE FROM pbem_games
        WHERE guild_id = ${guildId}
        RETURNING *
      `) as GameRow[];
      return rows.map(mapSnapshot);
    },

    async claimDraft(gameId: string, creatorId: string): Promise<GameSnapshot | null> {
      const rows = (await sql`
        UPDATE pbem_games SET status = 'creating', version = version + 1
        WHERE id = ${gameId} AND created_by = ${creatorId} AND status = 'setup'
        RETURNING *
      `) as GameRow[];
      return rows[0] ? mapSnapshot(rows[0]) : null;
    },

    async releaseDraft(gameId: string) {
      await sql`
        UPDATE pbem_games SET status = 'setup', version = version + 1
        WHERE id = ${gameId} AND status = 'creating'
      `;
    },

    async activateGame(
      gameId: string,
      selected: SelectedPlayer[],
      messageId: string,
      now = new Date().toISOString(),
    ): Promise<GameSnapshot> {
      const row = await getRow(gameId);
      if (!row || row.status !== "creating") {
        throw new Error("This game setup is no longer available.");
      }
      const activeMode = row.active_mode;
      const players = createInitialPlayers(selected, activeMode, now);
      const events = [
        ...parseJson<Array<Record<string, unknown>>>(row.events),
        {
          type: "players_selected",
          actorId: row.created_by,
          userIds: selected.map((player) => player.userId),
          createdAt: now,
        },
      ].slice(-100);
      const updated = (await sql`
        UPDATE pbem_games
        SET status = 'active', message_id = ${messageId},
            players = ${JSON.stringify(players)}::jsonb,
            events = ${JSON.stringify(events)}::jsonb,
            version = version + 1
        WHERE id = ${gameId} AND status = 'creating' AND version = ${row.version}
        RETURNING *
      `) as GameRow[];
      if (!updated[0]) throw new Error("Game setup changed; please start again.");
      return mapSnapshot(updated[0]);
    },

    async applyPlayerSelection(
      gameId: string,
      playerId: string,
      actorId: string,
    ): Promise<TransitionResult> {
      return applyTransition(gameId, "select_player", playerId, actorId);
    },

    async switchGameMode(gameId: string, actorId: string): Promise<TransitionResult> {
      return applyTransition(gameId, "switch_mode", null, actorId);
    },

  };
  return repository;

  async function applyTransition(
    gameId: string,
    action: "select_player" | "switch_mode",
    playerId: string | null,
    actorId: string,
  ): Promise<TransitionResult> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const row = await getRow(gameId);
      if (!row || row.status !== "active") {
        throw new Error("This game is no longer active.");
      }
      const snapshot = mapSnapshot(row);
      const state = {
        mode: snapshot.game.mode,
        activeMode: snapshot.game.activeMode,
        players: snapshot.players,
      };
      const transition =
        action === "switch_mode"
          ? switchMode(state, new Date().toISOString())
          : selectPlayer(state, playerId ?? "", new Date().toISOString());
      const now = new Date().toISOString();
      const event = {
        type: transition.eventType,
        actorId,
        playerId,
        activeMode: transition.state.activeMode,
        createdAt: now,
      };
      const events = [
        ...parseJson<Array<Record<string, unknown>>>(row.events),
        event,
      ].slice(-100);
      const updated = (await sql`
        UPDATE pbem_games
        SET active_mode = ${transition.state.activeMode},
            players = ${JSON.stringify(transition.state.players)}::jsonb,
            events = ${JSON.stringify(events)}::jsonb,
            version = version + 1
        WHERE id = ${gameId} AND status = 'active' AND version = ${row.version}
        RETURNING *
      `) as GameRow[];
      if (updated[0]) {
        return {
          ...mapSnapshot(updated[0]),
          eventType: transition.eventType,
        };
      }
    }
    throw new Error("The game changed concurrently; please click again.");
  }
}

export type Repository = ReturnType<typeof openRepository>;

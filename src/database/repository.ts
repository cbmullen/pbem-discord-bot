import { neon } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { createInitialPlayers, selectPlayer, switchMode } from "../game/turns.js";
import type {
  ActiveMode,
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
  guildId: string;
  channelId: string;
  createdBy: string;
}

export interface TransitionResult extends GameSnapshot {
  notifyUserIds: string[];
  eventType: string;
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
  let schemaPromise: Promise<void> | undefined;

  function ensureSchema(): Promise<void> {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        await sql`
          CREATE TABLE IF NOT EXISTS pbem_games (
            id uuid PRIMARY KEY,
            name text NOT NULL,
            mode text NOT NULL CHECK (mode IN ('consecutive', 'simultaneous', 'both')),
            active_mode text NOT NULL CHECK (active_mode IN ('consecutive', 'simultaneous')),
            guild_id text NOT NULL,
            channel_id text NOT NULL,
            message_id text,
            created_by text NOT NULL,
            created_at timestamptz NOT NULL,
            status text NOT NULL CHECK (status IN ('setup', 'creating', 'active')),
            players jsonb NOT NULL DEFAULT '[]'::jsonb,
            events jsonb NOT NULL DEFAULT '[]'::jsonb,
            version integer NOT NULL DEFAULT 0
          )
        `;
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS pbem_unique_game_name_per_channel
        ON pbem_games (guild_id, channel_id, lower(name))
      `;
      })().catch((error: unknown) => {
        schemaPromise = undefined;
        throw error;
      });
    }
    return schemaPromise;
  }

  async function getRow(gameId: string): Promise<GameRow | undefined> {
    await ensureSchema();
    const rows = (await sql`
      SELECT * FROM pbem_games WHERE id = ${gameId} LIMIT 1
    `) as GameRow[];
    return rows[0];
  }

  const repository = {
    async createDraft(input: NewGame, now = new Date().toISOString()) {
      await ensureSchema();
      await sql`
        DELETE FROM pbem_games
        WHERE status <> 'active' AND created_at < NOW() - INTERVAL '24 hours'
      `;
      const id = randomUUID();
      const activeMode: ActiveMode =
        input.mode === "both" ? "consecutive" : input.mode;
      await sql`
        INSERT INTO pbem_games (
          id, name, mode, active_mode, guild_id, channel_id, created_by,
          created_at, status, events
        ) VALUES (
          ${id}, ${input.name}, ${input.mode}, ${activeMode}, ${input.guildId},
          ${input.channelId}, ${input.createdBy}, ${now}, 'setup',
          ${JSON.stringify([{ type: "game_created", actorId: input.createdBy, createdAt: now }])}::jsonb
        )
      `;
      return id;
    },

    async deleteDraft(gameId: string) {
      await ensureSchema();
      await sql`
        DELETE FROM pbem_games WHERE id = ${gameId} AND status = 'setup'
      `;
    },

    async getSnapshot(gameId: string): Promise<GameSnapshot | null> {
      const row = await getRow(gameId);
      return row ? mapSnapshot(row) : null;
    },

    async getActiveGameByName(
      guildId: string,
      channelId: string,
      name: string,
    ): Promise<GameSnapshot | null> {
      await ensureSchema();
      const rows = (await sql`
        SELECT * FROM pbem_games
        WHERE guild_id = ${guildId} AND channel_id = ${channelId}
          AND status = 'active' AND lower(name) = lower(${name.trim()})
        LIMIT 1
      `) as GameRow[];
      return rows[0] ? mapSnapshot(rows[0]) : null;
    },

    async claimDraft(gameId: string, creatorId: string): Promise<GameSnapshot | null> {
      await ensureSchema();
      const rows = (await sql`
        UPDATE pbem_games SET status = 'creating', version = version + 1
        WHERE id = ${gameId} AND created_by = ${creatorId} AND status = 'setup'
        RETURNING *
      `) as GameRow[];
      return rows[0] ? mapSnapshot(rows[0]) : null;
    },

    async releaseDraft(gameId: string) {
      await ensureSchema();
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

    async listActiveGames(guildId: string, channelId: string): Promise<Game[]> {
      await ensureSchema();
      const rows = (await sql`
        SELECT * FROM pbem_games
        WHERE guild_id = ${guildId} AND channel_id = ${channelId}
          AND status = 'active'
        ORDER BY created_at DESC
      `) as GameRow[];
      return rows.map((row) => mapSnapshot(row).game);
    },
  };
  return repository;

  async function applyTransition(
    gameId: string,
    action: "select_player" | "switch_mode",
    playerId: string | null,
    actorId: string,
  ): Promise<TransitionResult> {
    await ensureSchema();
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
          notifyUserIds: transition.notifyUserIds,
          eventType: transition.eventType,
        };
      }
    }
    throw new Error("The game changed concurrently; please click again.");
  }
}

export type Repository = ReturnType<typeof openRepository>;

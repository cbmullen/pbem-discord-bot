import { neon } from "@neondatabase/serverless";

type NeonClient = ReturnType<typeof neon<false, false>>;

const migrations: Array<(sql: NeonClient) => Promise<void>> = [
  async (sql) => {
    await sql`
      CREATE TABLE IF NOT EXISTS pbem_games (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        mode text NOT NULL CHECK (mode IN ('consecutive', 'simultaneous', 'both')),
        active_mode text NOT NULL CHECK (active_mode IN ('consecutive', 'simultaneous')),
        reminder_days integer NOT NULL DEFAULT 0 CHECK (reminder_days BETWEEN 0 AND 365),
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
      ALTER TABLE pbem_games
      ADD COLUMN IF NOT EXISTS reminder_days integer NOT NULL DEFAULT 0
      CHECK (reminder_days BETWEEN 0 AND 365)
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS pbem_reminder_deliveries (
        game_id uuid NOT NULL REFERENCES pbem_games(id) ON DELETE CASCADE,
        user_id text NOT NULL,
        pending_since timestamptz NOT NULL,
        claimed_at timestamptz NOT NULL,
        sent_at timestamptz,
        PRIMARY KEY (game_id, user_id, pending_since)
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS pbem_processed_interactions (
        interaction_id text PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS pbem_unique_game_name_per_server
      ON pbem_games (guild_id, lower(name))
    `;
    await sql`DROP INDEX IF EXISTS pbem_unique_game_name_per_channel`;
  },
  async (sql) => {
    // One row per player per server: a holiday applies to every game they are in.
    await sql`
      CREATE TABLE IF NOT EXISTS pbem_away (
        guild_id text NOT NULL,
        user_id text NOT NULL,
        until timestamptz,
        set_by text NOT NULL,
        set_at timestamptz NOT NULL DEFAULT NOW(),
        PRIMARY KEY (guild_id, user_id)
      )
    `;
  },
  async (sql) => {
    await sql`
      CREATE TABLE IF NOT EXISTS pbem_game_archive (
        game_id uuid PRIMARY KEY,
        name text NOT NULL,
        mode text NOT NULL CHECK (mode IN ('consecutive', 'simultaneous', 'both')),
        active_mode text NOT NULL CHECK (active_mode IN ('consecutive', 'simultaneous')),
        reminder_days integer NOT NULL,
        guild_id text NOT NULL,
        channel_id text NOT NULL,
        message_id text,
        created_by text NOT NULL,
        created_at timestamptz NOT NULL,
        completed_at timestamptz NOT NULL,
        winner_user_id text NOT NULL,
        players jsonb NOT NULL,
        events jsonb NOT NULL
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS pbem_game_archive_completed_at
      ON pbem_game_archive (completed_at DESC)
    `;
  },
  async (sql) => {
    await sql`
      CREATE TABLE IF NOT EXISTS pbem_notification_preferences (
        guild_id text NOT NULL,
        user_id text NOT NULL,
        delivery text NOT NULL CHECK (delivery IN ('dm', 'channel', 'none')),
        quiet_start smallint,
        quiet_end smallint,
        utc_offset_minutes smallint,
        PRIMARY KEY (guild_id, user_id),
        CHECK (
          (quiet_start IS NULL AND quiet_end IS NULL AND utc_offset_minutes IS NULL)
          OR (
            quiet_start IS NOT NULL
            AND quiet_end IS NOT NULL
            AND utc_offset_minutes IS NOT NULL
            AND
            quiet_start BETWEEN 0 AND 1439
            AND quiet_end BETWEEN 0 AND 1439
            AND quiet_start <> quiet_end
            AND utc_offset_minutes BETWEEN -720 AND 840
          )
        )
      )
    `;
  },
  async (sql) => {
    await sql`
      CREATE TABLE IF NOT EXISTS pbem_public_archive_totals (
        id boolean PRIMARY KEY DEFAULT true CHECK (id),
        completed_games bigint NOT NULL,
        total_game_duration_ms double precision NOT NULL
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS pbem_public_archive_player_stats (
        user_id text PRIMARY KEY,
        username text NOT NULL,
        username_completed_at timestamptz NOT NULL,
        username_game_id uuid NOT NULL,
        games_played bigint NOT NULL,
        wins bigint NOT NULL,
        completed_turns bigint NOT NULL,
        total_turn_duration_ms double precision NOT NULL
      )
    `;
    await sql`
      INSERT INTO pbem_public_archive_totals (
        id, completed_games, total_game_duration_ms
      )
      SELECT
        true,
        COUNT(*),
        COALESCE(SUM(GREATEST(
          0,
          EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000
        )), 0)
      FROM pbem_game_archive
      ON CONFLICT (id) DO UPDATE
      SET completed_games = EXCLUDED.completed_games,
          total_game_duration_ms = EXCLUDED.total_game_duration_ms
    `;
    await sql`
      WITH player_rows AS (
        SELECT
          archive.game_id,
          archive.completed_at,
          member.user_id,
          COALESCE(
            player.value->'notificationUsernames'->>((member.ordinality - 1)::int),
            player.value->>'username'
          ) AS username,
          player.value->>'userId' = archive.winner_user_id AS won,
          COALESCE((player.value->>'completedTurns')::bigint, 0) AS completed_turns,
          COALESCE((player.value->>'totalTurnDurationMs')::float8, 0) AS total_turn_duration_ms
        FROM pbem_game_archive AS archive
        CROSS JOIN LATERAL jsonb_array_elements(archive.players) AS player(value)
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(player.value->'notificationUserIds') = 'array'
              AND jsonb_array_length(player.value->'notificationUserIds') > 0
            THEN player.value->'notificationUserIds'
            ELSE jsonb_build_array(player.value->>'userId')
          END
        ) WITH ORDINALITY AS member(user_id, ordinality)
      )
      INSERT INTO pbem_public_archive_player_stats (
        user_id, username, username_completed_at, username_game_id,
        games_played, wins, completed_turns, total_turn_duration_ms
      )
      SELECT
        user_id,
        (ARRAY_AGG(username ORDER BY completed_at DESC, game_id DESC))[1],
        (ARRAY_AGG(completed_at ORDER BY completed_at DESC, game_id DESC))[1],
        (ARRAY_AGG(game_id ORDER BY completed_at DESC, game_id DESC))[1],
        COUNT(*),
        COUNT(*) FILTER (WHERE won),
        SUM(completed_turns),
        SUM(total_turn_duration_ms)
      FROM player_rows
      GROUP BY user_id
      ON CONFLICT (user_id) DO UPDATE
      SET username = EXCLUDED.username,
          username_completed_at = EXCLUDED.username_completed_at,
          username_game_id = EXCLUDED.username_game_id,
          games_played = EXCLUDED.games_played,
          wins = EXCLUDED.wins,
          completed_turns = EXCLUDED.completed_turns,
          total_turn_duration_ms = EXCLUDED.total_turn_duration_ms
    `;
  },
  async (sql) => {
    await sql`
      CREATE INDEX IF NOT EXISTS pbem_processed_interactions_created_at
      ON pbem_processed_interactions (created_at)
    `;
  },
  async (sql) => {
    await sql`
      CREATE TABLE IF NOT EXISTS pbem_public_api_rate_limits (
        client_key text PRIMARY KEY,
        window_started_at timestamptz NOT NULL,
        request_count integer NOT NULL CHECK (request_count > 0)
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS pbem_public_api_rate_limits_window_started_at
      ON pbem_public_api_rate_limits (window_started_at)
    `;
  },
];

export async function migrateDatabase(databaseUrl: string): Promise<void> {
  const sql = neon(databaseUrl);
  await sql`
    CREATE TABLE IF NOT EXISTS pbem_schema_migrations (
      version integer PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT NOW()
    )
  `;

  const applied = new Set(
    ((await sql`SELECT version FROM pbem_schema_migrations`) as Array<{ version: number }>)
      .map(({ version }) => version),
  );
  for (const [index, migrate] of migrations.entries()) {
    const version = index + 1;
    if (applied.has(version)) continue;
    await migrate(sql);
    await sql`
      INSERT INTO pbem_schema_migrations (version)
      VALUES (${version})
      ON CONFLICT (version) DO NOTHING
    `;
  }
}

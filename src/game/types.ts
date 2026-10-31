export type GameMode = "consecutive" | "simultaneous" | "both";
export type ActiveMode = Exclude<GameMode, "both">;
export type PlayerStatus = "pending" | "done";
export type GameStatus = "setup" | "active";

export interface Game {
  id: string;
  name: string;
  mode: GameMode;
  activeMode: ActiveMode;
  reminderDays: number;
  guildId: string;
  channelId: string;
  messageId: string | null;
  createdBy: string;
  createdAt: string;
  status: GameStatus;
}

export interface Player {
  userId: string;
  username: string;
  position: number;
  status: PlayerStatus;
  pendingSince: string | null;
  lastUpdatedAt: string;
  /** Whether this player is currently marked away on their server. */
  away?: boolean;
}

export interface SelectedPlayer {
  userId: string;
  username: string;
}

export interface AwayInfo {
  /** ISO timestamp when the player is back, or null when no return date was set. */
  until: string | null;
}

/** Active away records for one server, keyed by Discord user id. */
export type AwayMap = Record<string, AwayInfo>;

export interface GameSnapshot {
  game: Game;
  players: Player[];
  /** Server-wide away records. Absent means "not loaded", which reads as nobody away. */
  away?: AwayMap;
}

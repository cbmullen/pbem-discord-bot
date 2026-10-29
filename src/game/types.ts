export type GameMode = "consecutive" | "simultaneous" | "both";
export type ActiveMode = Exclude<GameMode, "both">;
export type PlayerStatus = "pending" | "done";
export type GameStatus = "setup" | "active";

export interface Game {
  id: string;
  name: string;
  mode: GameMode;
  activeMode: ActiveMode;
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
}

export interface SelectedPlayer {
  userId: string;
  username: string;
}

export interface GameSnapshot {
  game: Game;
  players: Player[];
}


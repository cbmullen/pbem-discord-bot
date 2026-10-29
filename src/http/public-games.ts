import type { PublicGameStatus } from "../database/repository.js";

export type NamedPublicGame = Omit<PublicGameStatus, "guildId"> & {
  serverName: string;
};

export function addServerNames(
  games: PublicGameStatus[],
  guildNames: Map<string, string>,
): NamedPublicGame[] {
  return games.map(({ guildId, ...game }) => ({
    ...game,
    serverName: guildNames.get(guildId) ?? "Unavailable server",
  }));
}

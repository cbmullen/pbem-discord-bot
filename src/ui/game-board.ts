import type { GameSnapshot } from "../game/types.js";

interface ButtonComponent {
  type: 2;
  style: 1 | 2;
  label: string;
  custom_id: string;
}

interface ActionRow {
  type: 1;
  components: ButtonComponent[];
}

export interface DiscordMessagePayload {
  content: string;
  components: ActionRow[];
  allowed_mentions: { users: string[] };
}

export function buildGameBoard(
  snapshot: GameSnapshot,
  announcePending = false,
): DiscordMessagePayload {
  const { game, players } = snapshot;
  const pending = players.filter((player) => player.status === "pending");
  const titleMode =
    game.mode === "both"
      ? `both: ${game.activeMode}`
      : game.activeMode;
  const components: ActionRow[] = [];

  for (let index = 0; index < players.length; index += 5) {
    components.push({
      type: 1,
      components: players.slice(index, index + 5).map((player) => ({
        type: 2,
        style: player.status === "pending" ? 1 : 2,
        label: `${player.username} - ${player.status}`.slice(0, 80),
        custom_id: `pbem:player:${game.id}:${player.userId}`,
      })),
    });
  }

  if (game.mode === "both") {
    const switchButton: ButtonComponent = {
      type: 2,
      style: 2,
      label: `Switch to ${game.activeMode === "consecutive" ? "simultaneous" : "consecutive"}`,
      custom_id: `pbem:mode:${game.id}`,
    };
    const lastRow = components.at(-1);
    if (lastRow && lastRow.components.length < 5) {
      lastRow.components.push(switchButton);
    } else {
      components.push({ type: 1, components: [switchButton] });
    }
  }

  return {
    content: `**PBEM: ${game.name} [${titleMode}]**\nPending: ${pending.map((player) => `<@${player.userId}>`).join(", ") || "nobody"}`,
    components,
    allowed_mentions: {
      users: announcePending ? pending.map((player) => player.userId) : [],
    },
  };
}

import { activeAway, awayLabel, awayPlayers } from "../game/away.js";
import type { GameSnapshot } from "../game/types.js";

interface ButtonComponent {
  type: 2;
  style: 1 | 2 | 3;
  disabled?: boolean;
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
  now: Date = new Date(),
): DiscordMessagePayload {
  const { game, players } = snapshot;
  const pending = players.filter((player) => player.status === "pending");
  const away = activeAway(snapshot.away, now);
  const awayNow = awayPlayers(players, away, now);
  const components: ActionRow[] = [];

  for (let index = 0; index < players.length; index += 5) {
    components.push({
      type: 1,
      components: players.slice(index, index + 5).map((player): ButtonComponent => {
        const awayInfo = away[player.userId];
        if (awayInfo) {
          // Grey but deliberately not `disabled`: Discord does not deliver clicks
          // on disabled buttons, and this one explains how to bring the player back.
          const suffix = ` - ${awayLabel(awayInfo.until, now)}`;
          return {
            type: 2,
            style: 2,
            label: `${player.username.slice(0, 80 - suffix.length)}${suffix}`,
            custom_id: `pbem:away:${game.id}:${player.userId}`,
          };
        }
        return {
          type: 2,
          style: player.status === "pending" ? 1 : 3,
          disabled:
            game.activeMode === "consecutive" && player.status === "pending",
          label: `${player.username} - ${player.status}`.slice(0, 80),
          custom_id: `pbem:player:${game.id}:${player.userId}`,
        };
      }),
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
    content:
      `**Playing: ${game.name}**\nPending: ${pending.map((player) => `<@${player.userId}>`).join(", ") || "nobody"}` +
      (awayNow.length > 0
        ? `\n⏸️ **Paused** - waiting for ${awayNow.map((player) => `<@${player.userId}>`).join(", ")} to return.`
        : ""),
    components,
    allowed_mentions: {
      users: announcePending ? pending.map((player) => player.userId) : [],
    },
  };
}

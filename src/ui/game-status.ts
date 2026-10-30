import type { GameSnapshot } from "../game/types.js";

export function buildGameStatusEmbed(snapshot: GameSnapshot) {
  const { game, players } = snapshot;
  const pendingPlayers = players.filter((player) => player.status === "pending");
  const startedAt = Math.floor(Date.parse(game.createdAt) / 1000);
  const started = Number.isFinite(startedAt)
    ? `<t:${startedAt}:f>`
    : game.createdAt;

  return {
    title: game.name.replaceAll("@", "@\u200b"),
    color: 0x2ecc71,
    fields: [
      { name: "Players", value: String(players.length), inline: true },
      { name: "Pending", value: String(pendingPlayers.length), inline: true },
      { name: "Started", value: started, inline: true },
      {
        name: "Turn mode",
        value: `${game.activeMode}${game.mode === "both" ? " (switchable)" : ""}`,
        inline: true,
      },
      {
        name: "Automated reminders",
        value: game.reminderDays === 0
          ? "Off"
          : `After ${game.reminderDays} day${game.reminderDays === 1 ? "" : "s"} pending`,
        inline: true,
      },
    ],
    description: players.length
      ? players.map((player) => {
          const pendingSince = player.pendingSince
            ? Math.floor(Date.parse(player.pendingSince) / 1000)
            : Number.NaN;
          const pendingDuration = player.status === "pending" && Number.isFinite(pendingSince)
            ? ` · <t:${pendingSince}:R>`
            : "";
          const username = player.username.replaceAll("@", "@\u200b");
          return `• ${username} — ${player.status === "pending" ? "Pending" : "Done"}${pendingDuration}`;
        }).join("\n")
      : "No players",
  };
}

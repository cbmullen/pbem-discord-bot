import "dotenv/config";
import { commands } from "./commands/definitions.js";

const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
const applicationId = process.env.DISCORD_APPLICATION_ID?.trim();
if (!botToken || !applicationId) {
  throw new Error("DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID must be configured.");
}
try {
  const response = await fetch(
    `https://discord.com/api/v10/applications/${applicationId}/commands`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    },
  );
  if (!response.ok) {
    throw new Error(`Discord returned ${response.status}: ${await response.text()}`);
  }
  console.log(`Registered ${commands.length} global application commands.`);
} catch (error) {
  console.error("Could not register Discord commands:", error);
  process.exitCode = 1;
}

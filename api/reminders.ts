import { openRepository } from "../src/database/repository.js";
import type { DueReminder } from "../src/database/repository.js";

const DISCORD_API = "https://discord.com/api/v10";

async function discordPost(path: string, token: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${DISCORD_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `Discord API POST ${path} failed (${response.status}): ${await response.text()}`,
    );
  }
  return response.json();
}

async function sendReminder(reminder: DueReminder, botToken: string): Promise<void> {
  const channel = await discordPost("/users/@me/channels", botToken, {
    recipient_id: reminder.userId,
  }) as { id: string };
  const days = reminder.reminderDays === 1
    ? "1 day"
    : `${reminder.reminderDays} days`;
  const boardUrl = reminder.messageId
    ? `\n[Open the game board](https://discord.com/channels/${reminder.guildId}/${reminder.channelId}/${reminder.messageId})`
    : "";
  await discordPost(`/channels/${channel.id}/messages`, botToken, {
    content: `Reminder: **${reminder.gameName}** has been waiting for your turn for ${days}.${boardUrl}`,
    allowed_mentions: { parse: [] },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET" },
      });
    }

    const cronSecret = process.env.CRON_SECRET?.trim();
    if (!cronSecret) {
      console.error("Automated reminder endpoint is missing CRON_SECRET.");
      return Response.json({ error: "Service unavailable" }, { status: 503 });
    }
    if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const databaseUrl = process.env.DATABASE_URL?.trim();
    const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
    if (!databaseUrl || !botToken) {
      console.error("Automated reminders require DATABASE_URL and DISCORD_BOT_TOKEN.");
      return Response.json({ error: "Service unavailable" }, { status: 503 });
    }

    const repository = openRepository(databaseUrl);
    const dueReminders = await repository.listDueReminders();
    let sent = 0;
    let failed = 0;

    for (let index = 0; index < dueReminders.length; index += 5) {
      await Promise.all(
        dueReminders.slice(index, index + 5).map(async (reminder) => {
          const claimed = await repository.claimReminderDelivery(reminder);
          if (!claimed) return;

          try {
            await sendReminder(reminder, botToken);
            await repository.markReminderSent(reminder);
            sent += 1;
          } catch (error) {
            failed += 1;
            console.error(
              `Could not send automated PBEM reminder for game "${reminder.gameName}" to player ${reminder.userId}:`,
              error,
            );
            try {
              await repository.releaseReminderClaim(reminder);
            } catch (releaseError) {
              console.error("Could not release the failed PBEM reminder claim:", releaseError);
            }
          }
        }),
      );
    }

    console.log(`Automated PBEM reminders: ${sent} sent, ${failed} failed.`);
    return Response.json(
      { sent, failed },
      { status: failed > 0 ? 500 : 200 },
    );
  },
};

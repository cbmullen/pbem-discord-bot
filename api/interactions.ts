import { waitUntil } from "@vercel/functions";
import { handleDiscordRequest } from "../src/discord/interactions.js";

export default {
  async fetch(request: Request): Promise<Response> {
    return handleDiscordRequest(request, (task) => waitUntil(task));
  },
};


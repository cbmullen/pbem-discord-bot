# PBEM Discord bot

A serverless Discord application for play-by-email games. Discord sends slash
commands and button interactions to a Vercel HTTP function; game state is stored
in Neon Postgres. Neither a home computer nor a continuously running bot process
is required.

The app is designed for the [Vercel Hobby](https://vercel.com/pricing) and
[Neon Free](https://neon.com/pricing) plans. Free plans have usage and
availability limits that providers may change. Do not upgrade plans, add paid
services, or enable billing for this project. Check current provider terms as
part of setup.

## What you will set up

You will create three connected pieces:

1. A **Discord application**. Discord uses it to show the slash commands and
   send button, user-picker, and command interactions.
2. A **Neon Postgres project**. It stores game and player state so it survives
   Vercel function restarts.
3. A **Vercel project**. It hosts the HTTPS endpoint Discord calls when users
   interact with the bot.

The dependency order is important: create the Discord app and Neon database
first; Vercel needs their credentials. Once Vercel gives you a deployment
address, add that address back into the Discord app.

## Requirements

- A GitHub account with access to this repository
- A Discord account and permission to add an app to the server(s) where you
  want to use the bot
- A Vercel account
- A Neon account
- Node.js 22 or newer if you will register commands or run local checks

You do not need to keep your computer running after deployment. A computer is
needed for the one-time local slash-command registration step described below.
This project uses a Vercel Function, not a long-running process, so there is no
bot process for you to start or keep open after deployment.

### Words used in this guide

- **Application ID:** Discord's public identifier for the app. It is not a
  password.
- **Bot token:** A secret credential that lets the app make requests to Discord.
- **Public Key:** A value Discord gives the app so the endpoint can verify
  incoming requests. Despite the word "key," this value is safe to put in Vercel
  environment variables; never substitute the bot token for it.
- **Environment variable:** A setting saved in Vercel for the deployed app.
  Values are not written into the source files.
- **Connection string:** The private address and login details used by the app
  to connect to the Neon database.

## 1. Create the Discord application

An application is the identity and settings container for the bot. Its bot token
and public key are different credentials, and the token must remain private.

### Create the app and bot user

1. Open the [Discord Developer Portal](https://discord.com/developers/applications)
   and sign in.
2. Select **New Application**.
3. Enter a recognizable name, such as `PBEM Helper`, accept the terms, and
   create the application.
4. On **General Information**, copy the **Application ID**. This is the
   `DISCORD_APPLICATION_ID` value. It is an identifier, not the bot token.
5. On the same page, copy the **Public Key**. This is the
   `DISCORD_PUBLIC_KEY` value. Discord uses it to verify that incoming HTTP
   requests really came from Discord.
6. Open **Bot** in the left navigation. If Discord asks to create a bot user,
   confirm it.
7. Under the bot's token section, select **Reset Token** or **View Token** as
   shown in the portal, complete any confirmation, and copy the token. This is
   `DISCORD_BOT_TOKEN`. Store it somewhere private. If you lose it, reset it
   and update Vercel with the new token.
8. Do not enable privileged Gateway intents for this app. It receives
   interactions over HTTPS and does not connect to Discord's Gateway.

### Invite the bot to your server

1. In the Developer Portal, open **OAuth2** and then **URL Generator** (the
   portal may show this under **Installation** in a newer layout).
2. Under **Scopes**, select:
   - `bot`
   - `applications.commands`
3. Under **Bot Permissions**, select:
   - **View Channels**
   - **Send Messages**
4. Copy the generated URL and open it in a browser.
5. Choose the server where you have permission to manage/invite apps, review the
   requested permissions, and select **Authorize**.
6. Repeat the invite process for each server where the bot should be available.
   The same application and bot can be installed in multiple servers.

The bot needs permission to view and send messages in the channel where `/pbem`
is run. You can restrict those channel permissions in Discord; the bot does not
need administrator permission.

If the bot is in the server but cannot access a particular channel, open that
channel's **Edit Channel → Permissions** settings and allow the bot to **View
Channel** and **Send Messages**. A channel-specific deny can override the
server-level permission.

Do not configure **Interactions Endpoint URL** yet. You will set it after
deploying to Vercel, when you know the final deployment address.

## 2. Create the Neon database

Neon hosts the Postgres database used by the bot. A database connection string
contains a password, so treat it like a secret.

1. Open the [Neon Console](https://console.neon.tech/) and sign in or create an
   account.
2. Select **Create project**.
3. Enter a project name, for example `pbem-discord-bot`.
4. Select the **Free** plan. Do not choose a paid plan or enable paid add-ons.
5. Choose a region near where the Vercel function will run, if the console asks
   for one. If unsure, accept the suggested default.
6. Keep the default Postgres version, default branch, database, and role unless
   the console requires a choice. Neon typically creates a `main` branch, a
   `neondb` database, and a default role for you.
7. Create the project and wait for Neon to finish provisioning it.
8. In the project, select **Connect**. In the **Connect to your branch** dialog,
   select the default branch, compute, database, and role.
9. Leave **Connection pooling** enabled. This provides a pooled connection
   string that works well for serverless functions.
10. Copy the complete connection string. It starts with `postgresql://`. It
    includes the role, password, server address, database name, and connection
    options. Do not remove any part of it.
11. Store it privately until you add it to Vercel as `DATABASE_URL` in step 3.
    Do not put it in a public GitHub file, chat, screenshot, or source code.

You do **not** need to create database tables or run SQL yourself. Database
schema changes are applied by the versioned `npm run migrate:db` command rather
than by Discord requests. Run it from the repository root with `DATABASE_URL`
set in `.env` before deploying schema changes or using a new database.
Afterward, you can confirm the tables from the project's **Tables** view in
Neon.

For Neon's current console layout and connection-string details, see
[Connect from any application](https://neon.com/docs/connect/connect-from-any-app).

Neon's Free compute can scale to zero after inactivity. This means the first
database request after a quiet period can take longer. Free-tier limits and
availability may change; do not upgrade or enable billing if you do not want to
spend money.

## 3. Deploy the app to Vercel

Vercel runs the HTTP endpoint. It needs the Discord credentials and Neon
connection string you collected in steps 1 and 2.

### Import the repository

1. Make sure the PBEM app files are pushed to the GitHub repository. Vercel
   deploys committed/pushed files; uncommitted changes on your computer are not
   included. If these implementation changes have not been committed and pushed
   yet, do that first. Never include your `.env` file or any credential in a
   commit.
   Database migrations are not run by Vercel. Before deploying a code change
   that requires a schema update, run `npm run migrate:db` locally against the
   same database using `DATABASE_URL` in `.env`.
2. Open [Vercel](https://vercel.com/) and sign in.
3. From the Vercel dashboard, select **Add New… → Project** (the wording may
   vary).
4. Connect your GitHub account if asked, then grant Vercel access to
   `cbmullen/pbem-discord-bot`.
5. Find that repository and select **Import**.
6. In the project configuration screen, leave **Root Directory** at the
   repository root. The bot's `package.json` and Vercel function are at the
   root of this repository.
7. If Vercel asks for a framework, choose **Other**. This project is a plain
   TypeScript Vercel Function, not a Next.js or other framework application.
8. Use these build settings if they are shown:
   - **Install Command:** `npm install`
   - **Build Command:** this is disabled by `vercel.json`. Do not override it
     in Project Settings. The `build` script in `package.json` is for local
     type-checking and does not create deployment output.
   - **Output Directory:** set to `public` (also configured in `vercel.json`).
   - **Development Command:** leave it blank/default
9. Keep the project on the **Hobby** plan. Do not add a card, upgrade the plan,
   enable paid features, or turn on paid usage for this project.

If GitHub does not show the repository, check that the correct GitHub account
is connected and that Vercel has permission to access this repository.

### Add the environment variables

Environment variables are private configuration values supplied to the
deployed app. In the Vercel project:

1. Open **Settings → Environment Variables**.
2. Add each variable below. Enter the variable name exactly as written, then
   paste its value into the value field. Do not include surrounding quotation
   marks unless they are part of the value.

   | Name | Value to use |
   |---|---|
   | `DISCORD_BOT_TOKEN` | Bot token copied from the Discord Developer Portal |
   | `DISCORD_APPLICATION_ID` | Application ID copied from Discord |
   | `DISCORD_PUBLIC_KEY` | Public Key copied from Discord |
   | `DATABASE_URL` | The entire Neon connection string beginning with `postgresql://` |
   | `CRON_SECRET` | A long random secret used to authorize the scheduled reminder endpoint |

Generate `CRON_SECRET` as a random value of at least 32 bytes, for example by
running `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`
in a terminal. Save it only in Vercel's environment settings and your private
local `.env`; do not commit it.

3. Select **Production** for each variable. You may also select **Preview** or
   **Development** if you intentionally want those deployments to use the same
   Discord app and Neon database. For a first setup, Production is sufficient.
4. Save the variables. Avoid taking screenshots that show their values.
5. Deploy the project. If you already deployed before adding variables, open
   **Deployments**, choose the latest deployment, and redeploy it so the
   function starts with the new configuration.
6. Wait until Vercel reports the deployment is ready.
7. Copy the deployment's HTTPS domain, for example
   `https://your-project.vercel.app`. You will use it in the next section.

Vercel creates preview deployments for Git changes and production deployments
for the configured production branch. Only the Production deployment address
should be configured in Discord for regular use.

## 4. Connect Discord to the Vercel deployment

This step tells Discord where to deliver commands, button clicks, and user
picker selections.

1. In the Discord Developer Portal, select your application.
2. Open **General Information**.
3. Find **Interactions Endpoint URL**.
4. Enter the Vercel address followed by `/api/interactions`. For example:
   `https://your-project.vercel.app/api/interactions`
   Replace `your-project.vercel.app` with the exact domain shown by Vercel. Do
   not include angle brackets, spaces, or a trailing path after
   `/api/interactions`.
5. Save the URL. Discord sends a signed test request (a Ping) to verify it. The
   endpoint should accept the check. If Discord rejects it, see
   [Troubleshooting](#troubleshooting).

The endpoint URL is public; the bot token and database URL are not. Never use a
secret value as part of the endpoint URL.

The same deployment also exposes:

- `GET /api/public-games` — public, read-only active-game and player status for
  the PBEM status page. It returns server names, game names, player display names
  and statuses, pending timestamps, active mode, and the configured automated
  reminder threshold. It
  does not return Discord IDs, server/channel IDs, creator IDs, or the interaction
  token. This endpoint intentionally allows cross-origin requests for the public
  notebook page. Anyone can view the returned status data.
- `GET /api/health` — checks that the function can connect to Neon and returns
  only `healthy` or `unhealthy`. It also supports CORS for the status badge.

The game status page is public, so treat the displayed game and player names and
turn statuses as public information. The API is read-only and requires no
additional Vercel secrets or paid services.

The public notebook's `pbem-status/config.js` must point to the Production
Vercel origin (not a deployment-specific preview URL) so the page can call these
two endpoints.

## 5. Register the slash commands

The interaction endpoint and command definitions are separate: deploying the
code does not automatically add `/pbem` to Discord's command list. Register the
commands once using the application ID and bot token.

1. On a trusted computer, open a terminal in the repository's root folder.
2. In VS Code, choose **Terminal → New Terminal**. The terminal usually starts
   in the repository folder. If it does not, enter this command and press
   Enter:

   ```powershell
   Set-Location C:\Code\pbem-discord-bot
   ```

   If your repository is in a different folder, replace the path with the path
   to your own `pbem-discord-bot` folder.
3. Make a private local copy of the example environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

4. Open `.env` in VS Code:

   ```powershell
   code .env
   ```

   If the `code` command is unavailable, use VS Code's **File → Open File**
   menu and open `.env` from the repository folder. This file is hidden
   from Git by `.gitignore`.
5. In `.env`, replace the blank values for `DISCORD_BOT_TOKEN` and
   `DISCORD_APPLICATION_ID` with the values from the Discord Developer Portal,
   and set `DATABASE_URL` to the Neon connection string:

   ```text
   DISCORD_BOT_TOKEN=put_the_bot_token_here
   DISCORD_APPLICATION_ID=put_the_application_id_here
   DATABASE_URL=the_neon_connection_string
   ```

   Keep the equals signs and do not add spaces around them. Do not share these
   values.
6. Save `.env`. Run the migration before deploying code that expects the schema,
   including when updating an existing deployment:

   ```powershell
   npm install
   npm run migrate:db
   ```

7. Register the Discord commands:

   ```powershell
   npm run register-commands
   ```

8. Look for the success message that says six global application commands were
   registered. If the command reports a Discord error, recheck the application
   ID/token pair in `.env`; they must belong to the same Discord application.

The command-registration script needs only the Discord token and application
ID; the migration command needs `DATABASE_URL`. The deployed Vercel app reads
its values from Vercel **Settings → Environment Variables**. Do not add a
connection string or bot token to source code or commit `.env`.

The command-registration script can safely be run again when slash-command
definitions change. It replaces the application's global command definitions.
New global commands can take a little while to appear in Discord. In a server
where the bot is installed, open the slash-command picker and check that
`/pbem`, `/pbem-remind`, `/pbem-reminders`, `/pbem-delete`, `/pbem-list`, and
`/pbem-delete-all` are listed.

## 6. Verify the bot

1. In a server where the bot is installed, go to a channel where it has
   permission to view and send messages.
2. Run `/pbem`.
3. Enter a distinctive game name and choose `consecutive`, `simultaneous`, or
   `both`.
4. Use the private Discord user picker to select at least one player, then
   submit the selection.
5. Confirm that a board message appears in the same channel, with the selected
   player buttons and the pending list.
6. Click a status button and confirm the board updates. For a `both` game, also
   test the mode-switch button.
7. Run `/pbem-remind` in the same channel and enter the game name to test the
   manual reminder.
8. Optionally run `/pbem-delete` with the game name, confirm deletion, and
   verify that the board is removed and the name can be reused.
9. Run `/pbem-list` to see active games, then `/pbem-delete-all` to review and
   confirm deletion of every game in the server.
10. In Neon, open **Tables** and confirm the PBEM tables exist.

If all these steps work, Discord, Vercel, and Neon are connected. Your computer
can now be turned off; Vercel handles interactions when Discord sends them.

## Troubleshooting

### Discord rejects the Interactions Endpoint URL

- Check that the Vercel deployment is **Ready** and that the URL ends exactly
  with `/api/interactions`.
- Check that `DISCORD_PUBLIC_KEY` in Vercel exactly matches the application's
  **Public Key**, not its token or application ID.
- Confirm that the four Discord/database variables were saved for **Production**.
- If scheduled reminders are enabled, also confirm `CRON_SECRET` is set for
  **Production**.
- After editing environment variables, redeploy so they take effect.
- In Vercel, open the latest deployment's function logs for errors.

### Vercel reports that the `public` output directory is missing

This app deploys as a Vercel Function in `api/`; it does not generate a static
site. The `build` script in `package.json` only type-checks and does not create
deployment output. The current Vercel build is invoking its static builder and
requires an output folder, so `vercel.json` explicitly sets `public` as that
folder; it contains only a `robots.txt` placeholder. The Discord interaction
handler remains the Vercel Function in `api/`. Commit and push these changes,
then redeploy. If the error remains, confirm the deployment used the latest
commit and that the project's **Build Command**, **Output Directory**, and
**Framework Preset** are not overriding the repository configuration.

### Commands do not appear in Discord

- Confirm the bot was invited with both `bot` and `applications.commands`
  scopes.
- Rerun `npm run register-commands` and check for a success message.
- Confirm the `.env` values used by the registration script belong to the same
  Discord application as the configured endpoint.
- Allow time for global commands to propagate.

### `/pbem` appears but returns an error

- Check the Vercel deployment logs for the function error.
- Recheck `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`,
  and `DATABASE_URL` for missing characters or extra spaces.
- Confirm the Neon connection string is complete, still valid, and copied from
  the intended project/branch/database/role.
- Confirm the bot has permission to send messages in the channel.

### Board or player selection does not complete

- Check the Vercel function logs and make sure the current deployment is ready.
- Confirm the channel allows the bot to view and send messages.
- The person who started `/pbem` must submit the user picker for that game setup.
- The picker can select up to 25 players for fixed modes, or 24 for `both`.

## Local development and validation

Local development is optional; it is not required for the deployed bot to
remain online. If you want to test the function on your own computer, open a
terminal in the repository root, copy `.env.example` to `.env`, and set the
values from the Discord, Neon, and Vercel setup steps above. In particular,
local development also needs the Discord Public Key, Neon `DATABASE_URL`, and
`CRON_SECRET`; command registration alone does not.

Then run:

```sh
npm install
npm run build
npm test
npm run register-commands
npm run dev
```

The reminder delivery integration test uses Neon. Set `TEST_DATABASE_URL` to a
dedicated test database (not the production database) and run
`npm run test:db`. The test applies migrations and deletes its temporary game
afterward. Without `TEST_DATABASE_URL`, the test is skipped by `npm test`.

## Automated dependency updates

The GitHub Actions workflow checks direct dependencies daily. Patch and minor
updates are proposed in a pull request after the build and tests pass. Major
updates are also included in a pull request for review, and their package names
and versions are sent to the Discord-compatible webhook stored in the
`PBEM_UPDATER_MAJOR_BUMP_NOTIFIER_WEBHOOK` repository secret. Major-update PRs
are still opened if the lockfile update, installation, build, or tests fail;
the PR body reports each validation result. Add the webhook secret in GitHub
under **Settings → Secrets and variables → Actions**. The workflow can also be
started manually from the repository's **Actions** tab.

`npm run dev` uses the Vercel CLI to serve the function locally. Discord cannot
send requests to a local-only address; to test live interactions locally, use a
public HTTPS tunnel and temporarily set the Discord Interactions Endpoint URL
to that tunnel's `/api/interactions` address. Restore the Vercel URL when the
local test is finished.

## Commands and turn behavior

- `/pbem name mode` creates a game in the current channel and presents a private
  Discord user picker. Choose 1–25 non-bot players, or 1–24 for a `both` game.
  Optionally set `reminder-days` (0–365) to privately DM pending players once
  they reach that many days pending. It defaults to `0`, which disables
  automated reminders.
- `/pbem-remind game` offers active games in the server as autocomplete
  suggestions, then manually mentions pending players in that game's channel.
  The command can be run in any channel in the server.
- `/pbem-reminders game days` changes the automated reminder threshold for an
  active game anywhere in the server. Set `days` to 0 to disable reminders.
  Reminders are checked daily at 09:00 UTC and sent privately by DM.
- `/pbem-delete game` offers active games in the server as autocomplete
  suggestions. Select one to review a confirmation, then remove the game and
  its board. Any server member can confirm deletion. The command can be run in
  any channel in that server.
- `/pbem-list` privately lists games in the server, including active-game
  mode/player/pending counts and any pending setups.
- `/pbem-delete-all` shows a confirmation before permanently deleting every
  game record in the current server, including pending setups. Any server
  member can confirm; the bot also attempts to remove each existing board.
- Automated reminders are checked daily at 09:00 UTC. Each player receives at
  most one DM per pending turn after the game's configured day threshold. DM
  delivery depends on the player's Discord privacy settings.
- A game name is reserved while its setup or active game record exists. Failed
  setup attempts are removed, and deleting an active game frees the name.
- Anyone can click any player's status button.
- Clicking a game-board button reposts the updated board at the end of the
  channel conversation, replacing the previous board message.
- Consecutive games start with the first selected player pending. Clicking a
  player's button makes that player the sole pending player.
- Simultaneous games start with everyone pending. Clicking toggles that player's
  status; when all players are done, everyone returns to pending.
- `both` games start in consecutive mode and include a switch button. Switching
  to simultaneous makes all players pending; switching back makes the first
  currently pending player the sole pending player.

The player limit keeps the board within Discord's per-message component limits,
including the mode-switch button in `both` games.


## Dashboard

A read-only dashboard is not included in this implementation. The database is
private; a dashboard can be added later with read-only access and without exposing
the bot token or database credentials to browser code.

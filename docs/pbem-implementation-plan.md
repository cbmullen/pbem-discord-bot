# PBEM Discord Application Implementation Plan

## Objective

Build a Discord bot that creates and manages play-by-email game instances with a single slash command:

`/pbem <game-name> <mode>`

Supported modes:

- `consecutive`
- `simultaneous`
- `both`

The flow should be:

1. The user runs `/pbem`.
2. The bot creates a new game record.
3. The bot automatically opens the Discord user picker.
4. The selected users are added as players.
5. A status board is created in Discord.
6. The game starts in the chosen turn mode.

---

## Command contract

### `/pbem`

Example usage:

- `/pbem My Campaign consecutive`
- `/pbem Weekend Match simultaneous`
- `/pbem Team Game both`

In Discord, `name` and `mode` are slash-command options. After selection, the
command opens a user picker in a private response. Discord's message-component
limit allows up to 25 players for fixed modes and 24 for `both` (which also has
a mode-switch button).

Manual reminders use `/pbem-remind` with an autocomplete game selector. The
command is used in the channel that contains the game's board.

### Validation

- `game-name` must be a valid string, ideally 1-80 characters.
- `mode` must be one of:
  - `consecutive`
  - `simultaneous`
  - `both`
- If the mode is invalid, the bot should show a helpful error and ask the user to retry.

### Setup flow

1. Validate command input.
2. Create a new `Game` record.
3. Store metadata such as:
   - game id
   - name
   - mode
   - guild id
   - channel id
   - created by
   - created at
4. Launch Discord user selection.
5. Save the selected users as `Player` records.
6. Post a game board to the channel.
7. Set the initial board state.

---

## Core gameplay logic

### Consecutive mode

- Only one player is pending at a time.
- A user marks their status as done.
- The next player becomes pending.
- This is useful for turn-based games where only one person acts at a time.

### Simultaneous mode

- Multiple players may be pending.
- The game waits until all players are done before resetting everyone back to pending.
- This suits group turn cycles where the group acts together.

### Both mode

- `both` means the game can switch between modes at runtime.
- A `both` game starts in consecutive mode.
- The current mode should be stored per game and changed from the board or command flow.
- The mode switch is only relevant when the selected mode for the game is `both`; it is not used for `consecutive` or `simultaneous` games.
- Because no admin settings are required, the mode switch should be part of the normal game interaction rather than a restricted control.

---

## Discord UX design

### User selection

After command execution, the bot should automatically invoke the Discord user picker so the host can choose players without manual ID entry.

This avoids another setup step and matches the requirement to create players automatically from the selected users.

### Game board

The bot should create a single persistent Discord message for the game that includes:

- game name
- turn mode
- current pending users
- current done users
- a button per player
- no admin-only controls required

Suggested board structure:

- Header: `PBEM: {Game Name} [{Mode}]`
- Pending list: `@user1, @user2`
- Per-player buttons: `Pending` / `Done`
- Anyone may click any player button; the app updates the board after each click.

---

## Data model

### Game

- `id`
- `name`
- `mode`
- `guildId`
- `channelId`
- `messageId`
- `createdBy`
- `createdAt`
- `status`

### Player

- `id`
- `gameId`
- `discordUserId`
- `username`
- `status`
- `pendingSince`
- `lastUpdatedAt`

### Game event log

Store audit events such as:

- game created
- player added
- status changed
- mode toggled
- board reset
- reminder sent

This makes debugging and future reporting much easier.

---

## Architecture

### Free-tier constraint

This implementation is designed to use only no-cost tools and services:

- Discord bot app: free
- Node.js / TypeScript: free
- Vercel Hobby plan for serverless HTTP interactions: free within current limits
- Neon Free plan for hosted PostgreSQL: free within current limits
- GitHub Pages for the read-only dashboard: free
- no paid hosting, database, or analytics services in v1

The app must not rely on a computer owned by the user staying online. Free-tier
quotas and availability may change; deployment must not enable billing.

### 1. Discord interaction service

Responsible for:

- Vercel serverless HTTP endpoint for Discord interactions
- Ed25519 signature verification for incoming Discord requests
- slash command registration
- button and user-picker interaction handling
- Discord REST API for board messages and notifications
- multi-server support without a persistent gateway connection

Suggested initial folder layout:

- `api/`
- `src/commands/`
- `src/discord/`
- `src/game/`
- `src/database/`
- `src/ui/`
- `vercel.json`

### 2. Game engine

Responsible for:

- applying turn rules
- calculating pending users
- resetting state
- switching modes
- evaluating reminder conditions

### 3. Data layer

Recommended for v1:

- Neon Postgres using its serverless HTTP driver

Why:

- persistent data remains available when Vercel functions stop
- works from serverless functions
- no local filesystem persistence is required
- the Free plan currently does not require a credit card

---

## Recommended implementation sequence

### Phase 1: Serverless bot bootstrap

- deploy a Vercel HTTP function
- configure Discord's Interactions Endpoint URL
- verify signed Ping/Pong requests
- register slash commands

### Phase 2: Game creation

- implement `/pbem`
- validate game name and mode
- create a `Game` record
- launch user picker
- store selected users as players

### Phase 3: Status board

- create a persistent message for the board
- render each player with a status button
- display pending users above the buttons
- update the board when a user clicks

### Phase 4: Turn rules

- implement `consecutive` logic
- implement `simultaneous` logic
- implement `both` mode toggle logic
- ensure resets are deterministic and easy to test

### Phase 5: Notifications and reminders

- mention pending users when it is their turn
- add a manual reminder command for now
- track how long a user has been pending
- create stale-turn warnings

### Phase 6: Read-only dashboard

- expose active game status in a small web dashboard
- show pending/player timing metrics
- keep the dashboard read-only for now
- useful if you later want GitHub Pages or a minimal hosted app

---

## Technical implementation notes

### Discord API

- receive Discord interactions over HTTPS; do not open a persistent Gateway
  connection
- verify each request signature against the Discord application public key
- acknowledge interactions immediately, then finish work as a Vercel background
  task
- use Discord's REST API for creating and editing messages

### State management

Store game and player state in Neon Postgres. Do not depend on in-memory function
state because Vercel may start or stop function instances at any time.

### Reliability rules

- Save before sending notifications
- Update message state after persistence succeeds
- Handle invalid button interactions gracefully
- Require a consistent message id mapping for each game

---

## Confirmed product decisions

1. `both` means a single game can switch between turn modes at runtime.
2. Any user may click any player button.
3. There are no admin settings or admin-only controls in the initial release.
4. Multiple game instances are supported per server.
5. Reminders are manual for now.
6. The dashboard is read-only for now.
7. The first release supports multiple Discord servers.
8. The game board is created in the same channel where `/pbem` is run.
9. The mode switch is only used when the selected game mode is `both`.
10. A clean folder structure is in place from day one.
11. Game names are unique within each channel to make manual reminder targeting unambiguous.

### Important implementation concern

The mode-switching behavior for `both` must be explicit and deterministic. Because the game can switch between consecutive and simultaneous states at runtime, the switch action and its effect on current player statuses must be easy to reason about.

---

## Recommended MVP scope

For the first version, prioritize this sequence:

1. `/pbem <game-name> <mode>`
2. Create the game
3. User picker selects players
4. Create game board with status buttons
5. Implement `simultaneous` mode
6. Implement `consecutive` mode
7. Enable runtime switching for `both` mode after the core rules are working
8. Keep reminders manual and the dashboard read-only

This keeps the bot focused and reduces risk.

---

## Success criteria

The implementation is complete when:

- a user can create a game with one slash command
- players are selected automatically from Discord
- the game board renders current statuses
- `consecutive` and `simultaneous` behavior works reliably
- the app stores persistent state and can recover after restart
- the bot can notify pending players when appropriate

---

## Deployment notes

Set the Vercel project root directory to the repository root. Configure
`DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, and
`DATABASE_URL` in the Vercel project, then set the Discord Interactions Endpoint
URL to `https://<deployment-domain>/api/interactions`.

The read-only dashboard is a later phase and is not included in the bot MVP.

## Summary

This project uses a Vercel serverless HTTP endpoint and Neon Postgres so Discord
interactions and game state remain available without the user's computer running.
The command flow is `/pbem <name> <mode>`, then a Discord user picker automatically
creates the roster. The most important runtime rule is that `both` games start in
consecutive mode and switch explicitly from the game board.

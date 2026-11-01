# PBEM Discord Bot User Guide

This guide covers creating and running games with the PBEM Discord bot. It
assumes the bot is already installed in your server and its slash commands are
available. If you are setting up or hosting the bot, start with the
[deployment and setup instructions](../README.md).

## Getting started

Use the bot in a server channel where it can view the channel and send messages.
Start with `/pbem` to create a database-backed game. The bot responds privately
while you configure it, then posts the game board in the channel where you ran
the command.

Typical setup:

1. Run `/pbem`, enter a game name, choose a turn mode, and optionally choose the
   number of days before automated reminders.
2. Select players in the private picker. If you want teams or prefer to set up
   the roster later, choose **Skip for now**.
3. If you skipped, use `/pbem-teams` and `/pbem-players` to build the roster.
4. Check the board. Click a status button to update whose turn it is.
5. Use `/pbem-status` to check a game, `/pbem-remind` for an immediate channel
   reminder, or configure scheduled reminders with `/pbem-reminders` and
   `/pbem-notify`.

Commands that take a `game` option offer active games from this server in
Discord's autocomplete list. Select the game from that list. Games are separate
per server.

## Turn modes

Choose a mode when creating a game:

- **Consecutive**: only one roster entry is pending at a time. The first
  selected entry starts pending. Clicking another entry makes it the pending
  turn and marks the others done. In this mode, the pending entry's button is
  disabled.
- **Simultaneous**: all entries start pending. Clicking a button toggles that
  entry between pending and done. When everyone is done, a new round starts and
  everyone becomes pending again.
- **Both (switchable)**: starts in consecutive mode and adds a button to switch
  between consecutive and simultaneous. Switching to simultaneous makes
  everyone pending. Switching back makes the first currently pending entry the
  sole pending entry.

The board shows each roster entry's status and lists pending members. Anyone in
the server can click any enabled player button; the bot updates and reposts the
board as the latest message in its channel.

## Creating games and setting up a roster

### `/pbem name mode [reminder-days]`

Creates a database-backed game in the channel where you run the command.

- `name`: a 1–80 character game name. It must not already be in use in this
  server.
- `mode`: `consecutive`, `simultaneous`, or `both`.
- `reminder-days`: optional value from 0 to 365. `0` disables scheduled
  reminders for this game (the default); a positive number makes a pending
  player eligible after that many days.

After running the command, select non-bot server members in the private picker.
Fixed modes support up to 25 roster entries; `both` supports up to 24 so the
mode-switch button fits on the board. You can instead choose **Skip for now**
to create an empty game, then add players or teams with the commands below.
An empty game has no turn buttons until its roster is populated.

### `/pbem-players game action`

Adds individual players to, or removes players from, an active game.

- `game`: choose an active game using autocomplete.
- `action`: choose **Add players** or **Remove players**.
- Adding opens a server-member picker. The selected members must not already be
  in the game and the game cannot exceed its roster limit.
- Removing offers current roster entries only. Removing the current
  consecutive player advances the pending turn to the next remaining entry.
  The last roster entry cannot be removed; use `/pbem-delete` if you want to
  discard the game.
- In a simultaneous game, new entries start pending. In a consecutive game,
  additions join as done, except the first entry added to an empty game starts
  pending.

### `/pbem-teams game action`

Adds or removes a shared team. A team is one roster entry with one button and
one turn, shared by its members.

- `game`: choose an active game using autocomplete.
- `action`: choose **Add team** or **Remove team**.
- Adding opens a picker for 2–8 non-bot server members. Existing game members
  cannot be added to a team. The board label combines their Discord display
  names, and board announcements and scheduled reminders notify each team
  member. The first selected member represents the team's roster entry for
  away-status purposes.
- Removing offers existing shared teams. Removing a team removes its single
  roster entry.
- A new team joins pending in simultaneous mode or when it is the first entry
  in an empty consecutive game; otherwise it joins done.

The game roster limit counts a team as one entry, not as the number of people
on the team.

### `/pbem-nodb name mode`

Creates a board without connecting to the database. It asks for a name, mode,
and player selection, then stores the game state only in the Discord board.
Button clicks repost the updated board and remove the previous one.

This is a minimal, temporary board: deleting its board message loses the game.
Database-backed commands such as `/pbem-players`, `/pbem-teams`, `/pbem-status`,
`/pbem-remind`, `/pbem-away`, and `/pbem-gameover` do not manage no-database
games. It does not support the later roster setup workflow available to
`/pbem`.

## Checking and managing games

### `/pbem-list`

Privately lists the server's database-backed games, including game mode, roster
and pending counts, reminder threshold, and the channel. Pending setups that
have not yet completed player selection are also listed. No-database boards are
not included.

### `/pbem-help`

Use `/pbem-help command` to get a private summary of a specific command, or
leave `command` empty to receive the link to the full
[PBEM Discord Bot User Guide](https://cbmullen-inc.github.io/public-notebook/pbem-status/user-guide.html).
Command-specific help also includes the full guide link. This command does not
require the database.

### `/pbem-status game`

Privately displays the selected active game's roster, pending/done statuses,
turn mode, start time, reminder threshold, and any away players or pause status.
For a shared team, away status is associated with the first selected member who
represents its roster entry.

### `/pbem-rematch game name`

Starts a new game using the active game's players and teams. The rematch is
created in the original game's channel and keeps its mode and reminder
threshold, but resets turn statuses and turn statistics. It needs a new game
name that is not already in use in this server. The original game remains
active; finish it separately with `/pbem-gameover` if it is over.

## Notifications and reminders

Scheduled reminders require a positive reminder threshold on a game. The
scheduled job checks daily at **09:00 UTC** and considers players whose pending
turn has reached that game's threshold. A game is not reminded while any of
its players is away.

### `/pbem-reminders game days`

Changes the selected active game's scheduled reminder threshold:

- `days`: 0–365 days pending.
- `0` disables scheduled reminders for that game.
- A positive value makes pending players eligible once they have been pending
  at least that long. The daily job may send the reminder at its next run after
  the threshold is reached.

### `/pbem-notify delivery quiet-hours [user] [utc-offset]`

Sets scheduled reminder delivery for a member in this server. If `user` is
omitted, the settings apply to the person running the command. Any server
member can set or change another member's preferences.

- `delivery`: **Direct message**, **Ping in each game channel**, or **None**.
- `quiet-hours`: `off` or a local-time range such as `22:00-07:00` using a
  24-hour clock. The range can cross midnight.
- `user`: optional server member to configure.
- `utc-offset`: required when quiet hours are enabled, in a fixed-offset format
  such as `-07:00` or `+05:45`. It does not automatically change for daylight
  saving time. Omit it when quiet hours are `off`.

Examples:

- `/pbem-notify delivery:Direct message quiet-hours:off`
- `/pbem-notify delivery:Ping in each game channel quiet-hours:22:00-07:00 user:@Alex utc-offset:-07:00`
- `/pbem-notify delivery:None quiet-hours:off user:@Alex`

Users without saved settings get scheduled reminders by DM. A reminder skipped
because it falls in quiet hours is not marked as sent; the daily job checks
again on its next run. If 09:00 UTC always falls inside a user's recurring
quiet-hours window, their scheduled reminders remain skipped until the
preference or quiet-hours window changes.

These settings apply only to scheduled reminders. Board mentions and manual
`/pbem-remind` channel pings do not use them.

### `/pbem-remind game`

Immediately posts a channel reminder in the game's channel for currently
pending roster entries. You can run the command from any channel in the server.
It does not wait for the game's configured day threshold and does not use
`/pbem-notify` preferences. It does nothing if nobody is pending, and is
disabled while the game is paused because someone is away.

## Away status

Away status applies to a user across every database-backed game where they
represent a roster entry in the server. For a shared team, that is the first
selected member. While any roster entry in a game is away, the game is paused
for reminders; turn statuses do not change and other players can still use
their buttons.

### `/pbem-away [player] [until]`

Marks a player as away in every active game they are in (and in games they are
added to while still away).

- `player`: optional member; defaults to you. Any member can mark another
  member as away.
- `until`: optional return date in `YYYY-MM-DD` format, interpreted as 00:00
  UTC at the start of that date. It must be in the future and within 365 days.
- Leave `until` empty for an indefinite away status.

The bot refreshes boards for the affected player's active games. Away players
are shown in the board's away section.

### `/pbem-back [player]`

Clears a member's away status in this server. The optional `player` defaults to
you; any member can clear another member's status. All of that member's active
game boards in the server are refreshed.

Alternatively, any player can click the grey **Mark [player] back** button on
an away player's game board. This uses the same server-wide clear-and-refresh
behavior as `/pbem-back`. Clearing away status does not change the player's
pending/done status.

An away date also ends automatically at 00:00 UTC on the selected return date.
The daily job removes expired records and refreshes the affected boards.

## Finishing or deleting games

### `/pbem-gameover game`

Finishes a game and records the result:

1. Select the active game.
2. Review the confirmation. If you want a rematch, run `/pbem-rematch` before
   continuing.
3. Continue to choose the winning player or team, or cancel.

The bot posts a public congratulations message, removes the active board, and
archives the game snapshot and available event history. The game is removed
from active-game commands and its name becomes available again. The public
games API includes the 100 most recently completed games and cumulative stats
(wins, games played, completed turns, average turn duration, and average game
length) across all archived games.
Each member of a winning team receives a win in those stats. Historical turn
times can only be calculated for turns recorded by the bot; older turns cannot
be reconstructed.

### `/pbem-delete game`

Permanently deletes one active game without recording a winner or adding it to
the archive. Review the confirmation before proceeding. The bot also attempts
to remove the game board. Any server member can confirm.

### `/pbem-delete-all`

Shows a confirmation before permanently deleting every database-backed game
record in this server, including incomplete player-selection setups, and
attempts to remove their boards. This does not delete already archived games.
Any server member can confirm. This action cannot be undone.

## Quick reference

| What you want to do | Command |
|---|---|
| Open the user guide | `/pbem-help` |
| Start a database-backed game | `/pbem` |
| Start a board without database storage | `/pbem-nodb` |
| Add/remove individual players | `/pbem-players` |
| Add/remove shared teams | `/pbem-teams` |
| List games or inspect a game | `/pbem-list`, `/pbem-status` |
| Start a rematch | `/pbem-rematch` |
| Set a game's reminder delay | `/pbem-reminders` |
| Set scheduled delivery or quiet hours | `/pbem-notify` |
| Send an immediate pending-player ping | `/pbem-remind` |
| Mark a player away or back | `/pbem-away`, `/pbem-back`, or the board's grey back button |
| Record a winner and archive a game | `/pbem-gameover` |
| Delete one game or all server games | `/pbem-delete`, `/pbem-delete-all` |

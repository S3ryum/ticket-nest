# Ticket Nest

Ticket Nest is a self-hosted Discord support bot for small communities. It turns one public panel into private, persistent support channels with a short setup flow and a focused set of staff controls.

## Features

- Opens a private channel for the requester and the configured support role.
- Collects a subject and request details in a Discord modal.
- Prevents duplicate open or closed tickets for the same member and applies a small per-user creation rate limit.
- Lets the requester or support staff close a ticket; the requester or support staff can reopen a closed ticket.
- Lets support staff archive closed tickets, optionally move them to a separate category, and send a transcript to a configured log channel.
- Adds and removes extra participants with staff-only commands.
- Exports a private plain-text transcript for the requester or support staff. It includes message text and attachment links, capped at 500 messages and 3 MB.
- Writes ticket metadata and an audit history to a local JSON file using atomic replacement.
- Uses Discord application commands, buttons, and modals. It does not request the Message Content intent.

## Requirements

- Node.js 22.12 or newer
- A Discord application with a bot user
- A Discord server where you can install the bot and configure a support role

## Installation

```sh
git clone https://github.com/S3ryum/ticket-nest.git
cd ticket-nest
npm install
```

Copy `.env.example` to `.env` and fill in the application values:

```env
DISCORD_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-application-id
DISCORD_GUILD_ID=your-development-server-id
TICKET_DATA_DIR=./data
```

Keep `.env` private. The repository ignores it and the runtime ticket data directory. Never paste the bot token into an issue, chat, or public file. If a token is exposed, reset it in the Discord Developer Portal.

In the [Discord Developer Portal](https://discord.com/developers/applications), create an application, add a bot user, and copy its token into your local `.env`. Use OAuth2 scopes `bot` and `applications.commands` when installing it. Grant the bot these server permissions:

- Manage Channels
- Manage Roles
- View Channels
- Send Messages
- Read Message History
- Embed Links
- Attach Files

The bot does not need privileged gateway intents. Put its role high enough to manage the support role and any roles whose channel access it must change. Discord server owners and members with Administrator can still see private channels because Discord administrators bypass channel overwrites.

## Register commands and start

Register commands for a development server first. Guild commands become available faster:

```sh
npm run build
npm run register
npm start
```

Set `DISCORD_GUILD_ID` in `.env` to register guild-scoped commands. Remove that value to register global commands; global command changes can take longer to appear. Re-run `npm run register` after changing command definitions.

Ticket data is stored in `./data/state.json` by default. Back up this file with your bot host's normal backups. The bot must keep running on a reachable machine for interactions to work; this repository does not deploy it to a Discord server or host.

## Configure a server

In the text channel where you want the public panel, run `/ticket setup` and select a support role. Optionally choose an active ticket category, an archive category, and a private log channel. The command posts a panel in that channel.

Running setup again replaces the current configuration. Leave an optional category or log channel empty to clear it. Changing the support role also moves access on existing ticket channels to the new role. Make sure only trusted staff can read the configured log channel; archived transcripts are sent there when it is configured.

Members select **Open a ticket**, enter a subject and details, and receive a private ticket channel. The owner and support team can see it. Adding someone with `/ticket add` also gives that participant access until `/ticket remove` is used.

## Commands

| Command | Access | Purpose |
|---|---|---|
| `/ticket setup` | Manage Server | Configure the support role and categories; post a panel |
| `/ticket close [reason]` | Owner or support staff | Close the current ticket and stop requester messages |
| `/ticket reopen` | Owner or support staff | Reopen a closed ticket; only staff can reopen archived tickets |
| `/ticket archive` | Support staff | Archive a closed ticket and export its transcript to the log channel, if configured |
| `/ticket add member` | Support staff | Give a server member access to the ticket |
| `/ticket remove member` | Support staff | Remove a participant added to the ticket |
| `/ticket transcript` | Owner or support staff | Receive a private plain-text transcript |
| `/ticket stats` | Support staff | View open, closed, and archived ticket totals |

An archived channel remains in the server for staff review; Ticket Nest does not delete channels automatically. If an archive category is configured, the channel is moved there and hidden from the requester. Staff can reopen it from its ticket controls.

## Local verification

Build the TypeScript project and run the offline ticket lifecycle demonstration:

```sh
npm run build
npm run demo
```

The demo exercises open, close, reopen, close, and archive transitions, reloads persisted state, and checks that a requester cannot reopen an archived ticket. It does not connect to Discord. Verify your bot token, server installation, and role hierarchy in a private test server before relying on the live Discord integration.

## Data and privacy

`data/state.json` stores server, role, category, channel, and message identifiers along with ticket owner IDs, usernames, subjects, status, timestamps, and staff action history. Request details and conversation messages are not copied into that local state file. Transcript exports include message text and attachment URLs; they are sent only in the private command response or to the configured server log channel. Discord server administrators can access channel content regardless of Ticket Nest's private channel overwrites.

## Discord references

- [Application commands](https://discord.com/developers/docs/interactions/application-commands)
- [Receiving and responding to interactions](https://discord.com/developers/docs/interactions/receiving-and-responding)
- [Channels and permission overwrites](https://discord.com/developers/docs/resources/channel)
- [discord.js 14.27.0 API](https://discord.js.org/docs/packages/discord.js/14.27.0)

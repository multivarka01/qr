# twitch-tg-qr-overlay

A Twitch bot + OBS Browser Source overlay. When someone types `!qr <t.me link>` in Twitch chat, an animated card appears in OBS showing a Telegram post preview (avatar, channel name, subscribers, photo, text, reactions, views) alongside a styled QR code.

## Stack

- **Runtime:** Node.js 18+
- **Bot:** tmi.js (Twitch chat)
- **Server:** Express + WebSocket (ws)
- **Parsing:** cheerio + node-fetch (public Telegram embed pages)
- **Overlay:** Plain HTML/CSS/JS served as an OBS Browser Source

## How to run

```bash
npm start
```

The server starts on port 8080. In Replit the workflow `Start application` handles this automatically.

## Adding to OBS

1. Sources → **+** → **Browser Source**
2. URL: your Replit dev domain + `/overlay.html`
   (e.g. `https://<repl-name>.<username>.repl.co/overlay.html`)
3. Width/height: `1920 × 1080` (background is transparent)

## Environment variables / secrets

| Key | Description |
|-----|-------------|
| `TWITCH_BOT_USERNAME` | Twitch account the bot logs in as |
| `TWITCH_OAUTH_TOKEN` | OAuth token — get from https://twitchapps.com/tmi/ |
| `TWITCH_CHANNEL` | Channel name (no `#`) |
| `PORT` | Server port (set to `8080` for Replit) |
| `QR_COMMAND_PERMISSION` | `everyone`, `mods` (default), or `broadcaster` |
| `QR_COMMAND_COOLDOWN` | Anti-spam cooldown in seconds (default `15`) |
| `OVERLAY_DISPLAY_SECONDS` | How long the card stays on screen (default `12`) |

## Usage in chat

```
!qr https://t.me/your_channel        # shows latest post
!qr https://t.me/your_channel/123    # shows a specific post
```

## User preferences

_None recorded yet._

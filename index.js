// index.js
require('dotenv').config();

const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const tmi = require('tmi.js');

const { getTelegramPreview } = require('./lib/telegram');

// ---------- Startup validation ----------

const REQUIRED_ENV = ['TWITCH_BOT_USERNAME', 'TWITCH_OAUTH_TOKEN', 'TWITCH_CHANNEL'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`[startup] Отсутствуют обязательные переменные окружения: ${missing.join(', ')}`);
  console.error('[startup] Заполните .env (или Replit Secrets) и перезапустите приложение.');
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || '8123', 10);
const PERMISSION = (process.env.QR_COMMAND_PERMISSION || 'mods').toLowerCase();
const COOLDOWN_MS = parseInt(process.env.QR_COMMAND_COOLDOWN || '15', 10) * 1000;
const DISPLAY_SECONDS = parseInt(process.env.OVERLAY_DISPLAY_SECONDS || '12', 10);

// ---------- HTTP + WebSocket сервер (для OBS Browser Source) ----------

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => {
  console.log(`[server] Оверлей доступен по адресу http://localhost:${PORT}/overlay.html`);
});

const wss = new WebSocketServer({ server, path: '/ws' });
const overlayClients = new Set();

wss.on('connection', (ws) => {
  overlayClients.add(ws);
  console.log(`[server] Оверлей подключился (всего: ${overlayClients.size})`);
  ws.on('close', () => overlayClients.delete(ws));
});

function broadcastToOverlay(payload) {
  const data = JSON.stringify(payload);
  for (const client of overlayClients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

// ---------- Twitch-бот ----------

const tmiClient = new tmi.Client({
  options: { debug: false },
  identity: {
    username: process.env.TWITCH_BOT_USERNAME,
    password: process.env.TWITCH_OAUTH_TOKEN,
  },
  channels: [process.env.TWITCH_CHANNEL],
});

let lastTriggerAt = 0;

function userIsAllowed(tags) {
  if (PERMISSION === 'everyone') return true;
  const isBroadcaster = tags.badges && tags.badges.broadcaster === '1';
  const isMod = tags.mod || isBroadcaster;
  if (PERMISSION === 'broadcaster') return isBroadcaster;
  return isMod; // 'mods' (по умолчанию) — модераторы и стример
}

tmiClient.connect().catch((err) => {
  console.error('[twitch] Не удалось подключиться:', err.message);
});

tmiClient.on('connected', () => {
  console.log(`[twitch] Подключён к каналу #${process.env.TWITCH_CHANNEL}`);
});

tmiClient.on('message', async (channel, tags, message, self) => {
  if (self) return;
  const trimmed = message.trim();
  if (!trimmed.toLowerCase().startsWith('!qr')) return;

  if (!userIsAllowed(tags)) return;

  const now = Date.now();
  if (now - lastTriggerAt < COOLDOWN_MS) {
    return; // тихо игнорируем спам команды
  }

  const link = trimmed.slice(3).trim();
  if (!link) {
    tmiClient.say(channel, '@' + tags['display-name'] + ' использование: !qr <ссылка на t.me>');
    return;
  }

  try {
    const preview = await getTelegramPreview(link);
    lastTriggerAt = now;

    broadcastToOverlay({
      type: 'show_qr',
      displaySeconds: DISPLAY_SECONDS,
      data: {
        ...preview,
        link: preview.postUrl,
      },
    });

    if (preview.isFallback) {
      tmiClient.say(
        channel,
        `@${tags['display-name']} показал только QR — не нашёл последний пост (${preview.fallbackReason})`
      );
    }

    console.log(`[twitch] !qr вызван пользователем ${tags['display-name']}: ${link}`);
  } catch (err) {
    console.error('[twitch] Ошибка обработки !qr:', err.message);
    tmiClient.say(
      channel,
      `@${tags['display-name']} не получилось загрузить превью поста — проверь, что канал и пост публичные`
    );
  }
});

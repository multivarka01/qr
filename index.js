// index.js
require("dotenv").config();

const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");
const tmi = require("tmi.js");

const { getTelegramPreview } = require("./lib/telegram");

// ---------- Startup validation ----------

const REQUIRED_ENV = [
  "TWITCH_BOT_USERNAME",
  "TWITCH_OAUTH_TOKEN",
  "TWITCH_CHANNEL",
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(
    `[startup] Отсутствуют обязательные переменные окружения: ${missing.join(", ")}`,
  );
  console.error(
    "[startup] Заполните .env (или Replit Secrets) и перезапустите приложение.",
  );
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "8123", 10);
const PERMISSION = (process.env.QR_COMMAND_PERMISSION || "mods").toLowerCase();
const COOLDOWN_MS =
  parseInt(process.env.QR_COMMAND_COOLDOWN || "15", 10) * 1000;
const DISPLAY_SECONDS = parseInt(
  process.env.OVERLAY_DISPLAY_SECONDS || "12",
  10,
);

// ---------- HTTP + WebSocket сервер (для OBS Browser Source) ----------

const app = express();

// Health-check для Replit/Cloud Run: платформа периодически стучится на "/",
// ожидая ответ 200. Без этого маршрута она решает, что сервер "неисправен",
// и убивает процесс, приводя к постоянным перезапускам и дублирующимся
// инстансам бота (двойная обработка одной и той же команды !qr в чате).
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.use(express.static(path.join(__dirname, "public")));

const server = app.listen(PORT, () => {
  console.log(
    `[server] Оверлей доступен по адресу http://localhost:${PORT}/overlay.html`,
  );
});

const wss = new WebSocketServer({ server, path: "/ws" });
const overlayClients = new Set();

wss.on("connection", (ws) => {
  overlayClients.add(ws);
  console.log(`[server] Оверлей подключился (всего: ${overlayClients.size})`);
  ws.on("close", () => overlayClients.delete(ws));
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
let lastQrLink = null; // запомненная ссылка — !qr без аргумента покажет её снова

// ---------- Очередь команд !qr ----------
// Обрабатываем по одной — не даём новому запросу смешаться с текущим рендером.

const QR_QUEUE_MAX = 3; // максимум команд в очереди
const qrQueue = [];
let qrBusy = false;

async function processQrQueue(channel) {
  if (qrBusy || qrQueue.length === 0) return;
  qrBusy = true;
  const { tags, link, displaySeconds } = qrQueue.shift();
  try {
    const preview = await getTelegramPreview(link);
    broadcastToOverlay({
      type: "show_qr",
      // null = показывать бесконечно (до !qr off)
      displaySeconds: displaySeconds ?? null,
      data: { ...preview, link: preview.postUrl },
    });
    if (preview.isFallback) {
      tmiClient.say(
        channel,
        `@${tags["display-name"]} показал только QR — не нашёл последний пост (${preview.fallbackReason})`,
      );
    }
    console.log(
      `[twitch] !qr вызван пользователем ${tags["display-name"]}: ${link}`,
    );
  } catch (err) {
    console.error("[twitch] Ошибка обработки !qr:", err.message);
    tmiClient.say(
      channel,
      `@${tags["display-name"]} не получилось загрузить превью — проверь, что канал публичный`,
    );
  } finally {
    qrBusy = false;
    // небольшая пауза между показами чтобы оверлей успел смениться
    setTimeout(() => processQrQueue(channel), 500);
  }
}

function userIsAllowed(tags) {
  if (PERMISSION === "everyone") return true;
  const isBroadcaster = tags.badges && tags.badges.broadcaster === "1";
  const isMod = tags.mod || isBroadcaster;
  if (PERMISSION === "broadcaster") return isBroadcaster;
  return isMod; // 'mods' (по умолчанию) — модераторы и стример
}

tmiClient.connect().catch((err) => {
  console.error("[twitch] Не удалось подключиться:", err.message);
});

tmiClient.on("connected", () => {
  console.log(`[twitch] Подключён к каналу #${process.env.TWITCH_CHANNEL}`);
});

tmiClient.on("message", async (channel, tags, message, self) => {
  if (self) return;
  const trimmed = message.trim();
  if (!trimmed.toLowerCase().startsWith("!qr")) return;

  if (!userIsAllowed(tags)) return;

  const now = Date.now();
  if (now - lastTriggerAt < COOLDOWN_MS) {
    return; // тихо игнорируем спам команды
  }
  // Кулдаун обновляем сразу — даже если запрос упадёт с ошибкой,
  // чтобы сломанные ссылки не долбили Telegram без ограничений
  lastTriggerAt = now;

  const args = trimmed.slice(3).trim();

  // !qr off — скрыть оверлей
  if (args.toLowerCase() === 'off') {
    broadcastToOverlay({ type: 'hide_qr' });
    return;
  }

  // Парсим необязательное число секунд в конце: "ссылка 30" или просто "30"
  const secMatch = args.match(/(?:^|\s)(\d+)$/);
  const displaySeconds = secMatch ? parseInt(secMatch[1], 10) : null; // null = бесконечно
  const rest = secMatch ? args.slice(0, args.length - secMatch[0].length).trim() : args;

  if (!rest) {
    // !qr [секунды] — показываем пресет
    if (!lastQrLink) {
      tmiClient.say(channel, "@" + tags["display-name"] + " использование: !qr <ссылка на t.me>");
      return;
    }
    if (qrQueue.length >= QR_QUEUE_MAX) return;
    qrQueue.push({ tags, link: lastQrLink, displaySeconds });
    processQrQueue(channel);
    return;
  }

  // !qr <ссылка> [секунды] — новый пресет
  lastQrLink = rest;

  if (qrQueue.length >= QR_QUEUE_MAX) return;
  qrQueue.push({ tags, link: rest, displaySeconds });
  processQrQueue(channel);
});

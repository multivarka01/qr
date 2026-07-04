// lib/telegram.js
// Достаёт данные поста из публичной embed-версии t.me, без Bot API и без логина.
// Работает только с ПУБЛИЧНЫМИ каналами/постами.

const fetch = require('node-fetch');
const cheerio = require('cheerio');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 10_000;

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

/**
 * Принимает ссылку вида:
 *   https://t.me/channel/123
 *   https://t.me/channel/123?single
 *   t.me/channel/123
 * Возвращает { channelUsername, postId } или null, если это не ссылка на пост.
 */
function parseTelegramLink(rawUrl) {
  try {
    const url = new URL(
      rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`
    );
    if (!/(^|\.)t\.me$/.test(url.hostname) && !/(^|\.)telegram\.me$/.test(url.hostname)) {
      return null;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    // /channel/123  -> ['channel', '123']
    // /c/12345/123  -> приватные ссылки по id чата, превью так не достать
    if (parts.length >= 2 && parts[0] !== 'c') {
      const [channelUsername, postId] = parts;
      if (/^\d+$/.test(postId)) {
        return { channelUsername, postId, isChannelOnly: false };
      }
    }
    if (parts.length === 1) {
      return { channelUsername: parts[0], postId: null, isChannelOnly: true };
    }
    return null;
  } catch {
    return null;
  }
}

function absolutize(maybeUrl) {
  if (!maybeUrl) return null;
  if (maybeUrl.startsWith('//')) return `https:${maybeUrl}`;
  return maybeUrl;
}

/**
 * Скачивает картинку НА СЕРВЕРЕ и превращает в data:-URI (base64).
 * Это нужно, чтобы избежать CORS при встраивании аватарки в QR-код в браузере —
 * Telegram CDN не всегда отдаёт нужные заголовки, из-за чего qr-code-styling
 * не может посчитать размеры картинки и ломает позиционирование (мелкая
 * нецентрированная картинка вместо аккуратного круга по центру QR).
 */
async function toDataUri(url) {
  if (!url) return null;
  try {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const buf = await res.buffer();
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    return `data:${contentType};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function extractBgImage(styleAttr) {
  if (!styleAttr) return null;
  const m = styleAttr.match(/background-image:\s*url\(['"]?(.*?)['"]?\)/i);
  return m ? absolutize(m[1]) : null;
}

/**
 * Достаёт количество подписчиков канала с его публичной страницы t.me/<channel>
 * (блок ".tgme_page_extra", например "12 746 подписчиков" — Telegram отдаёт
 * локализованный текст по Accept-Language, у нас он выставлен в ru).
 */
async function fetchSubscriberCount(channelUsername) {
  try {
    const res = await fetchWithTimeout(`https://t.me/${channelUsername}`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.8' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    const extra = $('.tgme_page_extra').first().text().trim();
    return normalizeSubscriberCount(extra) || null;
  } catch {
    return null;
  }
}

/**
 * Грузит embed-версию поста (?embed=1&mode=tme) и парсит её.
 */
async function fetchPostPreview({ channelUsername, postId }) {
  const embedUrl = `https://t.me/${channelUsername}/${postId}?embed=1&mode=tme`;
  const res = await fetchWithTimeout(embedUrl, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.8' },
  });
  if (!res.ok) {
    throw new Error(`Не удалось загрузить пост (HTTP ${res.status})`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const root = $('.tgme_widget_message').first();
  if (root.length === 0) {
    throw new Error('Пост не найден или канал приватный');
  }

  const channelTitle = root.find('.tgme_widget_message_owner_name').first().text().trim();
  const avatarUrl = absolutize(root.find('.tgme_widget_message_user_photo img').attr('src'));
  // аватар и число подписчиков грузим параллельно, не задерживая друг друга
  const [avatarDataUri, subscriberCount] = await Promise.all([
    toDataUri(avatarUrl),
    fetchSubscriberCount(channelUsername),
  ]);

  // Собираем URL фотографий (max 2)
  const photoUrls = [];
  root.find('.tgme_widget_message_photo_wrap').each((_, el) => {
    const url = extractBgImage($(el).attr('style'));
    if (url) photoUrls.push(url);
  });

  // Конвертируем фото в data URI прямо на сервере — Telegram CDN блокирует
  // прямые запросы из браузера OBS (CORS), поэтому качаем через Node.js
  const photos = (
    await Promise.all(photoUrls.slice(0, 2).map(toDataUri))
  ).filter(Boolean);

  const textEl = root.find('.tgme_widget_message_text').first();
  textEl.find('br').replaceWith('\n');
  const text = textEl.text().replace(/\n{3,}/g, '\n\n').trim();

  const views = root.find('.tgme_widget_message_views').first().text().trim();
  const dateTime = root.find('time.time').attr('datetime');

  const reactions = [];
  root.find('.tgme_widget_message_reaction, [class*="reaction"]').each((_, el) => {
    const emoji = $(el).find('.tgme_widget_message_reaction_emoji, .emoji').first().text().trim()
      || $(el).text().match(/^\D+/)?.[0]?.trim();
    const countText = $(el).text().match(/(\d+)\s*$/)?.[1];
    if (emoji && countText) {
      reactions.push({ emoji, count: parseInt(countText, 10) });
    }
  });

  return {
    channelUsername,
    postId,
    channelTitle: channelTitle || channelUsername,
    subscriberCount,
    avatarUrl,
    avatarDataUri,
    photos,
    text,
    views,
    dateTime,
    reactions,
    postUrl: `https://t.me/${channelUsername}/${postId}`,
  };
}

/**
 * Telegram не всегда уважает Accept-Language и может отдать "36 subscribers"
 * вместо "36 подписчиков". Достаём только число из строки и сами
 * подставляем русское слово, чтобы не зависеть от локализации Telegram.
 */
function normalizeSubscriberCount(raw) {
  if (!raw) return null;
  const match = raw.replace(/\u00a0/g, ' ').match(/[\d\s]+/);
  if (!match) return raw; // не смогли найти число — возвращаем как есть
  const numStr = match[0].trim();
  const num = parseInt(numStr.replace(/\s/g, ''), 10);
  if (isNaN(num)) return raw;

  // простое согласование числительного с "подписчик"
  const mod100 = num % 100;
  const mod10 = num % 10;
  let word = 'подписчиков';
  if (mod100 < 11 || mod100 > 14) {
    if (mod10 === 1) word = 'подписчик';
    else if (mod10 >= 2 && mod10 <= 4) word = 'подписчика';
  }
  return `${numStr} ${word}`;
}

/**
 * Находит id последнего публичного поста в канале через t.me/s/<channel> —
 * публичную "ленту" канала (та же страница, что видна без логина в браузере).
 *
 * Возвращает { postId } либо { postId: null, reason } с пояснением, почему
 * пост не нашёлся — это попадает в лог консоли и в сообщение бота в чат,
 * чтобы не было тихого "пустого" фолбэка без объяснений.
 */
async function fetchLatestPostId(channelUsername) {
  const res = await fetchWithTimeout(`https://t.me/s/${channelUsername}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.8' },
  });
  if (!res.ok) {
    throw new Error(`Не удалось загрузить канал (HTTP ${res.status})`);
  }
  const html = await res.text();

  // основной способ: через cheerio по классу сообщения
  const $ = cheerio.load(html);
  let posts = $('.tgme_widget_message[data-post]');

  // запасной способ: на случай если Telegram чуть поменял разметку —
  // ищем data-post="channel/id" прямо в сыром HTML регуляркой
  let dataPostAttrs = posts.toArray().map((el) => $(el).attr('data-post')).filter(Boolean);
  if (dataPostAttrs.length === 0) {
    dataPostAttrs = [...html.matchAll(/data-post="([a-zA-Z0-9_]+\/\d+)"/g)].map((m) => m[1]);
  }

  if (dataPostAttrs.length === 0) {
    // пробуем понять, ПОЧЕМУ ничего не нашли — частые причины:
    let reason = 'на странице канала не нашлось ни одного поста';
    if (/Channel.+can.t be displayed|cannot be displayed/i.test(html)) {
      reason = 'Telegram скрыл превью этого канала (ограничение по возрасту/контенту)';
    } else if (/tgme_page_title/i.test(html) === false && /tgme_widget_message/i.test(html) === false) {
      reason = `канал @${channelUsername} не найден (проверь правильность username)`;
    } else if (html.length < 2000) {
      reason = 'Telegram вернул неожиданно короткую страницу — возможно, временная блокировка по частоте запросов';
    }
    return { postId: null, reason };
  }

  // последняя запись в ленте = самый свежий пост
  const lastDataPost = dataPostAttrs[dataPostAttrs.length - 1];
  const [, postId] = lastDataPost.split('/');
  return { postId: postId || null, reason: postId ? null : 'не удалось распарсить id поста' };
}

/**
 * Если ссылка ведёт просто на канал (без id поста) — берём только шапку канала.
 */
async function fetchChannelPreview({ channelUsername }) {
  const res = await fetchWithTimeout(`https://t.me/${channelUsername}?embed=1`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.8' },
  });
  if (!res.ok) {
    throw new Error(`Не удалось загрузить канал (HTTP ${res.status})`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const channelTitle = $('.tgme_page_title span').first().text().trim();
  const avatarUrl = absolutize($('.tgme_page_photo_image img').attr('src'));
  const subscriberCount = normalizeSubscriberCount($('.tgme_page_extra').first().text().trim()) || null;
  const avatarDataUri = await toDataUri(avatarUrl);

  return {
    channelUsername,
    channelTitle: channelTitle || channelUsername,
    subscriberCount,
    avatarUrl,
    avatarDataUri,
    photos: [],
    text: '',
    views: null,
    dateTime: null,
    reactions: [],
    postUrl: `https://t.me/${channelUsername}`,
  };
}

/**
 * Главная функция: ссылка -> объект с данными для оверлея.
 */
async function getTelegramPreview(rawUrl) {
  const parsed = parseTelegramLink(rawUrl);
  if (!parsed) {
    throw new Error('Это не похоже на ссылку t.me');
  }
  if (parsed.isChannelOnly) {
    const { postId, reason } = await fetchLatestPostId(parsed.channelUsername);
    if (postId) {
      return fetchPostPreview({ channelUsername: parsed.channelUsername, postId });
    }
    console.warn(`[telegram] Не нашёл последний пост @${parsed.channelUsername}: ${reason}`);
    // постов не нашли — fallback на шапку канала, но с пометкой почему
    const channelPreview = await fetchChannelPreview(parsed);
    return { ...channelPreview, isFallback: true, fallbackReason: reason };
  }
  return fetchPostPreview(parsed);
}

module.exports = { getTelegramPreview, parseTelegramLink };

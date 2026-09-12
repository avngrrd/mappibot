import path from 'node:path';
import { access } from 'node:fs/promises';
import { createTelegram, runPolling } from './telegram.mjs';
import { openStore, acquireLock } from './store.mjs';
import { createProviders } from './providers.mjs';
import { createBot } from './bot.mjs';
import { createKyivProvider } from './kyiv.mjs';
import { createMapData } from './map-data.mjs';
import { createMapServer } from './map-server.mjs';
import { readMapUrl } from './tunnel-url.mjs';

let release;
let mapServer;
let stopTimer;
let menuTimer;
try {
  const inviteCode = process.env.INVITE_CODE || '';
  const allowedUserIds = (process.env.ALLOWED_USER_IDS || '').split(',').filter(Boolean).map(Number);
  if (allowedUserIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid ALLOWED_USER_IDS');
  if ((inviteCode && !/^[A-Za-z0-9_-]{16,64}$/.test(inviteCode)) || (!inviteCode && allowedUserIds.length === 0)) {
    throw new Error('Set a random INVITE_CODE (16–64 URL-safe characters) or ALLOWED_USER_IDS.');
  }
  const dataDir = path.resolve(process.env.DATA_DIR || 'data');
  const telegram = createTelegram(process.env.TELEGRAM_BOT_TOKEN);
  release = await acquireLock(dataDir);
  const store = await openStore(dataDir);
  const me = await telegram.call('getMe');
  const webhook = await telegram.call('getWebhookInfo');
  if (webhook.url) throw new Error('A webhook is configured. Review the existing deployment before switching to polling.');
  const providers = createProviders({
    userAgent: process.env.USER_AGENT || 'MappiBot/0.1 (https://github.com/avngrrd/mappibot)',
    overpassUrl: process.env.OVERPASS_URL || undefined,
    nominatimUrl: process.env.NOMINATIM_URL || undefined,
    dniproUrl: process.env.DNIPRO_URL || undefined
  });
  providers.liveKyiv = createKyivProvider({
    url: process.env.KYIV_GTFS_RT_URL || undefined,
    userAgent: process.env.USER_AGENT || 'MappiBot/0.1 (https://github.com/avngrrd/mappibot)'
  });
  let mapUrl = '';
  const syncMapUrl = async () => {
    try {
      const raw = process.env.MAP_URL_FILE ? await readMapUrl(process.env.MAP_URL_FILE) : process.env.MAP_URL;
      if (!raw || raw === mapUrl) return;
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search) return;
      await telegram.call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Карта', web_app: { url: parsed.href } } });
      mapUrl = raw;
    } catch { /* A tunnel may still be starting. The next check retries. */ }
  };
  const mapPort = Number(process.env.MAP_PORT || 8787);
  if (!Number.isInteger(mapPort) || mapPort < 1 || mapPort > 65535) throw new Error('Invalid MAP_PORT');
  mapServer = createMapServer({
    botToken: process.env.TELEGRAM_BOT_TOKEN, previewKey: process.env.MAP_PREVIEW_KEY || '', store, allowedUserIds, providers,
    mapData: createMapData({ overpassUrl: process.env.OVERPASS_URL || undefined,
      userAgent: process.env.USER_AGENT || 'MappiBot/0.1 (https://github.com/avngrrd/mappibot)' })
  });
  await new Promise((resolve, reject) => { mapServer.once('error', reject); mapServer.listen(mapPort, '127.0.0.1', resolve); });
  await syncMapUrl();
  let syncing = false;
  menuTimer = setInterval(async () => {
    if (syncing) return;
    syncing = true;
    try { await syncMapUrl(); } finally { syncing = false; }
  }, 5000);
  const bot = createBot({ telegram, providers, store, inviteCode, allowedUserIds, getMapUrl: () => mapUrl, onForget: id => mapServer.revokeUser(id) });
  await telegram.call('setMyCommands', { commands: [
    { command: 'start', description: 'Головне меню' },
    { command: 'map', description: 'Карта Києва: транспорт і маршрути' },
    { command: 'city', description: 'Знайти місто або місце' },
    { command: 'favorites', description: 'Обрані зупинки' },
    { command: 'live', description: 'GPS Києва: експериментальне покриття' },
    { command: 'coverage', description: 'Джерела й покриття України' },
    { command: 'forget', description: 'Видалити мої збережені дані' },
    { command: 'id', description: 'Мій Telegram ID' },
    { command: 'help', description: 'Як користуватися' }
  ] });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  if (process.env.STOP_FILE) stopTimer = setInterval(async () => {
    try { await access(process.env.STOP_FILE); controller.abort(); } catch { /* Not requested. */ }
  }, 1000);
  console.log(`MappiBot started: @${me.username}. Private invitations enabled.`);
  await runPolling({ telegram, bot, store, signal: controller.signal });
} catch (error) {
  // Only controlled errors are useful; never dump cause, requests, updates or stacks.
  const message = typeof error.message === 'string' ? error.message : 'Startup failed';
  const token = process.env.TELEGRAM_BOT_TOKEN;
  console.error(token ? message.split(token).join('[REDACTED]') : message);
  process.exitCode = 1;
} finally {
  clearInterval(stopTimer);
  clearInterval(menuTimer);
  if (mapServer) { mapServer.closeAllConnections(); await new Promise(resolve => mapServer.close(resolve)); }
  await release?.();
}

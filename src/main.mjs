import path from 'node:path';
import { createTelegram, runPolling } from './telegram.mjs';
import { openStore, acquireLock } from './store.mjs';
import { createProviders } from './providers.mjs';
import { createBot } from './bot.mjs';
import { createKyivProvider } from './kyiv.mjs';

let release;
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
  const bot = createBot({ telegram, providers, store, inviteCode, allowedUserIds });
  await telegram.call('setMyCommands', { commands: [
    { command: 'start', description: 'Головне меню' },
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
  console.log(`MappiBot started: @${me.username}. Private invitations enabled.`);
  await runPolling({ telegram, bot, store, signal: controller.signal });
} catch (error) {
  // Only controlled errors are useful; never dump cause, requests, updates or stacks.
  const message = typeof error.message === 'string' ? error.message : 'Startup failed';
  const token = process.env.TELEGRAM_BOT_TOKEN;
  console.error(token ? message.split(token).join('[REDACTED]') : message);
  process.exitCode = 1;
} finally {
  await release?.();
}

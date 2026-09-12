import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { TelegramError } from './telegram.mjs';

const TTL_MS = 15 * 60 * 1000;
const LIVE_MAX_AGE_MS = 3 * 60 * 1000;
const MAX_SESSIONS = 1000;
const MAX_ACTIONS = 80;
const MAX_FAVORITES = 20;
const MENU = {
  keyboard: [
    [{ text: '📍 Зупинки поруч', request_location: true }],
    [{ text: '🔎 Пошук місця' }, { text: '⭐ Обране' }],
    [{ text: '🚌 GPS Київ' }, { text: 'ℹ️ Покриття' }],
  ],
  resize_keyboard: true,
};
const INVITE = 'Це приватний бот для друзів. Відкрийте посилання-запрошення від власника, щоб отримати доступ. Ваш ID: /id';
const EXPIRED = 'Ця кнопка застаріла або належить іншому користувачу. Повторіть пошук.';
const COVERAGE = '🇺🇦 Основне місто — Київ. Пошук місць і зупинок — по всій Україні за даними OpenStreetMap, де їх нанесено на карту. Для іншого міста: /city вокзал, Львів. Повнота даних залежить від населеного пункту.\n\n🚌 GPS Києва — експериментальний: лише позиції з власною часовою позначкою не старші 3 хвилин. Міське джерело може містити неповні або неактуальні дані. ID маршруту в джерелі може відрізнятися від номера на транспорті. Немає загальноукраїнського GPS, гарантованого розкладу або прогнозу прибуття. Це початкова версія, а не повний аналог EasyWay.\n\nДані карти: © OpenStreetMap contributors — https://www.openstreetmap.org/copyright';

function text(value, max = 150) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max);
}

function hasCoordinates(value) {
  return value && typeof value.lat === 'number' && Number.isFinite(value.lat)
    && typeof value.lon === 'number' && Number.isFinite(value.lon)
    && value.lat >= -90 && value.lat <= 90 && value.lon >= -180 && value.lon <= 180;
}

function sameSecret(provided, expected) {
  if (typeof expected !== 'string' || !expected.length || typeof provided !== 'string') return false;
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

function commandOf(value) {
  const match = /^\/([a-z]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(value.trim());
  return match ? { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() } : null;
}

function savedStop(stop) {
  const osmIds = Array.isArray(stop.osmIds)
    ? [...new Set(stop.osmIds.filter((id) => typeof id === 'string' && /^(node|way|relation)\/\d+$/.test(id)))].slice(0, 20) : [];
  return { id: text(stop.id, 100), name: text(stop.name || 'Зупинка'), lat: stop.lat, lon: stop.lon, mode: text(stop.mode, 40), ...(osmIds.length ? { osmIds } : {}) };
}

function routeLabel(vehicle) {
  return `${vehicle.routeIsPublicNumber === true ? 'Маршрут' : 'ID маршруту'} ${text(vehicle.route || '?', 24)}`;
}

function stopUrl(stop) {
  return /^node\/\d+$|^way\/\d+$|^relation\/\d+$/.test(stop.id)
    ? `https://www.openstreetmap.org/${stop.id}` : 'https://www.openstreetmap.org';
}

function clockTime(value) {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(value));
}

/** Build the private bot without networking or starting a polling loop. */
export function createBot({ telegram, providers, store, inviteCode, allowedUserIds = [], now = Date.now }) {
  if (!telegram?.call || !providers || !store?.users || typeof store.save !== 'function') {
    throw new TypeError('Bot requires telegram, providers and a persistent store');
  }
  const allowed = new Set(allowedUserIds.map(String));
  const sessions = new Map();
  const authorized = (id) => allowed.has(id) || Object.hasOwn(store.users, id);
  const send = (chatId, value, extra = {}) => telegram.call('sendMessage', { chat_id: chatId, text: value, ...extra });
  const answer = (callback, value) => telegram.call('answerCallbackQuery', {
    callback_query_id: callback.id, ...(value ? { text: value } : {}),
  });

  function sessionFor(id) {
    const current = now();
    for (const [key, value] of sessions) {
      if (current - value.lastSeen > TTL_MS) sessions.delete(key);
    }
    let session = sessions.get(id);
    if (!session) {
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      session = { lastSeen: current, lastRequest: -Infinity, actions: new Map() };
      sessions.set(id, session);
    }
    session.lastSeen = current;
    for (const [key, action] of session.actions) if (action.expires <= current) session.actions.delete(key);
    return session;
  }

  function button(id, label, action) {
    const session = sessionFor(id);
    while (session.actions.size >= MAX_ACTIONS) session.actions.delete(session.actions.keys().next().value);
    const token = `m:${randomBytes(12).toString('base64url')}`;
    session.actions.set(token, { ...action, expires: now() + TTL_MS });
    return { text: text(label, 60), callback_data: token };
  }

  function throttled(session) {
    const current = now();
    if (current - session.lastRequest < 1000) return true;
    session.lastRequest = current;
    return false;
  }

  async function menu(chatId) {
    return send(chatId, '🇺🇦 Маппі — транспорт поруч. Основне місто — Київ.\n\nНадішліть геолокацію або назву місця в Києві, наприклад «Контрактова площа». Покажу найближчі зупинки. Для іншого міста вкажіть його через кому або використайте /city.\n\n/city вокзал, Львів — пошук по Україні\n/favorites — обране\n/live — експериментальний GPS Києва\n/live 104 — фільтр маршруту\n/coverage — покриття\n/forget — видалити мої збережені дані\n/id — мій Telegram ID\n\nКоординати не зберігаю на диску. Зупинка потрапляє до обраного лише за вашим натисканням. Тимчасові результати доступні до 15 хвилин.', { reply_markup: MENU });
  }

  async function nearby(id, chatId, position) {
    const stops = (await providers.nearbyStops(position.lat, position.lon)).filter(hasCoordinates).slice(0, 8);
    if (!stops.length) {
      return send(chatId, 'Поруч не знайшов нанесених зупинок. Спробуйте інше місце: дані OpenStreetMap можуть бути неповними.');
    }
    return send(chatId, 'Найближчі зупинки за даними OpenStreetMap. Оберіть зупинку, щоб відкрити її на карті.\n© OpenStreetMap contributors', {
      reply_markup: { inline_keyboard: stops.map((stop) => [button(id,
        `${text(stop.name || 'Зупинка', 42)}${Number.isFinite(stop.distance) ? ` · ${Math.round(stop.distance)} м` : ''}`,
        { type: 'stop', stop: savedStop(stop) })]) },
    });
  }

  async function search(id, chatId, query) {
    query = query.trim().slice(0, 200);
    if (query.length < 2) return send(chatId, 'Напишіть назву місця й міста, наприклад «вокзал, Вінниця».');
    const places = (await providers.searchPlaces(query)).filter(hasCoordinates).slice(0, 6);
    if (!places.length) return send(chatId, 'Не знайшов такого місця в Україні. Додайте назву міста або надішліть геолокацію.');
    return send(chatId, 'Оберіть місце — знайду зупинки поруч.\n© OpenStreetMap contributors', {
      reply_markup: { inline_keyboard: places.map((place) => [button(id, place.name, {
        type: 'place', place: { lat: place.lat, lon: place.lon },
      })]) },
    });
  }

  const favoritesFor = (id) => Array.isArray(store.users[id]?.favorites) ? store.users[id].favorites : [];

  async function showStop(id, chatId, stop) {
    await telegram.call('sendVenue', {
      chat_id: chatId, latitude: stop.lat, longitude: stop.lon,
      title: text(stop.name || 'Зупинка', 100), address: 'Зупинка · дані OpenStreetMap',
    });
    let routeText;
    try {
      const routes = (await providers.stopRoutes(stop)).slice(0, 12);
      routeText = routes.length
        ? `Маршрути, прив’язані до зупинки в OpenStreetMap:\n${routes.map((route) => `• ${text(route.ref || route.name || 'Маршрут', 90)}${route.ref && route.name ? ` — ${text(route.name, 130)}` : ''}`).join('\n')}\n\nЦе довідкові дані, без перевірки фактичного руху та розкладу.`
        : 'В OpenStreetMap немає прив’язаних маршрутів. Це не означає, що транспорт тут не ходить.';
    } catch {
      routeText = 'Зупинку знайдено, але маршрути зараз недоступні. Спробуйте пізніше.';
    }
    const exists = favoritesFor(id).some((favorite) => favorite.id === stop.id);
    return send(chatId, `${routeText}\n\n© OpenStreetMap contributors`, {
      reply_markup: { inline_keyboard: [
        [button(id, exists ? '🗑 Прибрати з обраного' : '⭐ Зберегти зупинку', { type: exists ? 'remove' : 'save', stop })],
        [{ text: 'Карта OpenStreetMap', url: stopUrl(stop) }],
      ] },
    });
  }

  async function favorites(id, chatId) {
    const list = favoritesFor(id).filter(hasCoordinates).slice(0, MAX_FAVORITES);
    if (!list.length) return send(chatId, 'Обране поки порожнє. Відкрийте зупинку й натисніть «⭐ Зберегти зупинку».');
    return send(chatId, '⭐ Ваші збережені зупинки:', {
      reply_markup: { inline_keyboard: list.map((stop) => [
        button(id, stop.name, { type: 'stop', stop: savedStop(stop) }),
        button(id, '🗑', { type: 'remove', stop: savedStop(stop) }),
      ]) },
    });
  }

  async function persistFavorite(id, chatId, stop, remove) {
    const previous = store.users[id];
    const list = favoritesFor(id).filter(hasCoordinates).map(savedStop);
    if (!remove && list.some((item) => item.id === stop.id)) return send(chatId, 'Ця зупинка вже в обраному.');
    if (!remove && list.length >= MAX_FAVORITES) return send(chatId, 'В обраному вже 20 зупинок. Спочатку приберіть зайву: /favorites');
    store.users[id] = { favorites: remove ? list.filter((item) => item.id !== stop.id) : [...list, savedStop(stop)] };
    try { await store.save(); } catch (error) {
      if (previous) store.users[id] = previous; else delete store.users[id];
      throw error;
    }
    return send(chatId, remove ? 'Зупинку прибрано з обраного.' : '⭐ Зупинку збережено. Переглянути: /favorites');
  }

  function freshVehicle(vehicle) {
    if (!hasCoordinates(vehicle)) return false;
    const timestamp = Date.parse(vehicle.updatedAt);
    return Number.isFinite(timestamp) && now() - timestamp <= LIVE_MAX_AGE_MS && timestamp - now() <= 60_000;
  }

  async function live(id, chatId, routeFilter = '') {
    routeFilter = routeFilter.trim().slice(0, 32);
    const feed = await providers.liveKyiv(routeFilter);
    const valid = (feed.vehicles ?? []).filter(freshVehicle);
    const vehicles = valid.slice(0, 8);
    if (!vehicles.length) return send(chatId, `Немає свіжих GPS-позицій транспорту Києва${routeFilter ? ` для маршруту «${text(routeFilter, 32)}»` : ''}. Джерело може бути тимчасово недоступне або транспорт не передає координати. Це не означає, що рейсів немає.`);
    return send(chatId, `🚌 GPS Київ · експериментально${routeFilter ? ` · фільтр ${text(routeFilter, 32)}` : ''}\nПоказано ${vehicles.length}${valid.length > 8 ? ` із ${valid.length}` : ''} машин з координатами не старшими 3 хвилин. Оберіть машину для карти. Дані можуть охоплювати лише частину транспорту.${vehicles.some((vehicle) => vehicle.routeIsPublicNumber !== true) ? ' Позначка «ID маршруту» означає технічний ID джерела, а не номер на транспорті.' : ''} Прогнозу прибуття немає.\nФільтр: /live номер_маршруту`, {
      reply_markup: { inline_keyboard: vehicles.map((vehicle) => [button(id,
        `${text(routeLabel(vehicle), 30)} · ${text(vehicle.name || vehicle.id, 12)} · ${clockTime(vehicle.updatedAt).slice(-8)}`,
        { type: 'vehicle', vehicle: { ...savedStop(vehicle), route: text(vehicle.route, 32), routeIsPublicNumber: vehicle.routeIsPublicNumber === true, updatedAt: vehicle.updatedAt } })]) },
    });
  }

  async function callback(update, id, chatId) {
    const session = sessionFor(id);
    const action = session.actions.get(update.data);
    if (!action || action.expires <= now()) return answer(update, EXPIRED);
    if (throttled(session)) return answer(update, 'Зачекайте секунду й натисніть ще раз.');
    await answer(update);
    const dispatch = async () => { switch (action.type) {
      case 'place': return nearby(id, chatId, action.place);
      case 'stop': return showStop(id, chatId, action.stop);
      case 'save': return persistFavorite(id, chatId, action.stop, false);
      case 'remove': return persistFavorite(id, chatId, action.stop, true);
      case 'vehicle': {
        const vehicle = action.vehicle;
        if (!freshVehicle(vehicle)) return send(chatId, 'Ця GPS-позиція вже застаріла. Оновіть список: /live');
        return telegram.call('sendVenue', {
          chat_id: chatId, latitude: vehicle.lat, longitude: vehicle.lon,
          title: `Київ · ${routeLabel(vehicle)} · ${text(vehicle.name || vehicle.id, 40)}`,
          address: `GPS станом на ${clockTime(vehicle.updatedAt)} (Київ). Без прогнозу прибуття.`,
        });
      }
      default: return send(chatId, 'Повторіть пошук: /start');
    } };
    const result = await dispatch();
    session.actions.delete(update.data);
    return result;
  }

  async function handleUpdate(update) {
    const cb = update?.callback_query;
    const message = cb?.message ?? update?.message;
    const from = cb?.from ?? message?.from;
    if (!from || !Number.isSafeInteger(from.id) || from.id <= 0) return;
    if (message?.chat?.type !== 'private' || message.chat.id !== from.id) {
      if (cb?.id) await answer(cb, 'Відкрийте приватний чат із ботом.');
      return;
    }
    const id = String(from.id);
    const chatId = message.chat.id;
    const value = typeof message.text === 'string' ? message.text.trim() : '';
    const command = cb ? null : commandOf(value);
    try {
      if (command?.name === 'id') return await send(chatId, `Ваш Telegram ID: ${id}`);
      if (command?.name === 'start') {
        if (!authorized(id) && sameSecret(command.args, inviteCode)) {
          store.users[id] = { favorites: [] };
          try { await store.save(); } catch (error) { delete store.users[id]; throw error; }
        }
        return await (authorized(id) ? menu(chatId) : send(chatId, INVITE));
      }
      const session = sessionFor(id);
      if (!authorized(id)) {
        if (cb) return await answer(cb, 'Потрібне запрошення. Відкрийте /start у чаті з ботом.');
        if (!throttled(session)) return await send(chatId, INVITE);
        return;
      }
      if (cb) return await callback(cb, id, chatId);
      if (throttled(session)) return;
      if (command?.name === 'forget') {
        const previous = store.users[id];
        delete store.users[id];
        try { await store.save(); } catch (error) { if (previous) store.users[id] = previous; throw error; }
        sessions.delete(id);
        return await send(chatId, 'Збережені дані й тимчасовий пошук видалено. Для повторного входу скористайтеся запрошенням.', { reply_markup: { remove_keyboard: true } });
      }
      if (message.location) {
        const position = { lat: message.location.latitude, lon: message.location.longitude };
        if (!hasCoordinates(position)) return await send(chatId, 'Не вдалося прочитати координати. Надішліть геолокацію ще раз.');
        return await nearby(id, chatId, position);
      }
      if (command?.name === 'help') return await menu(chatId);
      if (command?.name === 'coverage' || value === 'ℹ️ Покриття') return await send(chatId, COVERAGE);
      if (command?.name === 'favorites' || value === '⭐ Обране') return await favorites(id, chatId);
      if (command?.name === 'live' || value === '🚌 GPS Київ') return await live(id, chatId, command?.args ?? '');
      if (command?.name === 'city') return await search(id, chatId, command.args);
      if (value === '🔎 Пошук місця') return await send(chatId, 'Напишіть назву місця в Києві, наприклад «Контрактова площа». Для іншого міста: «площа Ринок, Львів» або /city вокзал, Полтава.');
      if (value === '📍 Зупинки поруч') return await send(chatId, 'Надішліть геолокацію через кнопку нижче або меню вкладень Telegram.', { reply_markup: MENU });
      if (command || value.startsWith('/')) return await send(chatId, 'Такої команди немає. Доступні дії: /help');
      if (value) return await search(id, chatId, value.includes(',') ? value : `${value}, Київ`);
      return await send(chatId, 'Надішліть геолокацію або назву місця. Доступні дії: /help');
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      return await send(chatId, 'Сервіс тимчасово недоступний. Спробуйте ще раз трохи пізніше.');
    }
  }

  return { handleUpdate };
}

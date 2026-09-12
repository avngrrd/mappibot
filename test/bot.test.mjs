import test from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../src/bot.mjs';
import { TelegramError } from '../src/telegram.mjs';

const STOP = { id: 'node/123', name: 'Контрактова площа', lat: 50.465, lon: 30.516, distance: 55, mode: 'bus' };
const PLACE = { id: 'node/456', name: 'Поділ, Київ', lat: 50.467, lon: 30.516 };

function fixture(options = {}) {
  let time = Date.parse('2026-09-12T09:00:00Z');
  const sent = [];
  const providerCalls = [];
  let saveCount = 0;
  const store = { users: {}, save: async () => { saveCount++; }, ...options.store };
  const providers = {
    searchPlaces: async (query) => { providerCalls.push(['searchPlaces', query]); return [PLACE]; },
    nearbyStops: async (...args) => { providerCalls.push(['nearbyStops', ...args]); return [STOP]; },
    stopRoutes: async (stop) => { providerCalls.push(['stopRoutes', stop]); return [{ ref: '12', name: 'Центр — Поділ' }]; },
    liveKyiv: async (route) => { providerCalls.push(['liveKyiv', route]); return { vehicles: [], fetchedAt: new Date(time).toISOString() }; },
    ...options.providers,
  };
  const bot = createBot({
    telegram: options.telegram ?? { call: async (method, payload) => { sent.push({ method, ...structuredClone(payload) }); return {}; } },
    providers, store, inviteCode: 'friends-secret', allowedUserIds: options.allowedUserIds ?? [], now: () => time,
  });
  const message = (id, text, extra = {}) => ({ message: { from: { id }, chat: { id, type: 'private' }, text, ...extra } });
  const send = async (value, id = 11, extra = {}) => { time += 1001; await bot.handleUpdate(message(id, value, extra)); };
  const click = async (token, id = 11) => {
    time += 1001;
    await bot.handleUpdate({ callback_query: { id: `callback-${time}`, from: { id }, data: token, message: { chat: { id, type: 'private' } } } });
  };
  const last = () => sent.at(-1);
  const token = (row = 0, column = 0) => last().reply_markup.inline_keyboard[row][column].callback_data;
  return { bot, sent, store, providerCalls, send, click, last, token, message,
    advance: (ms) => { time += ms; }, now: () => time, saves: () => saveCount };
}

test('private access requires an invitation; /id remains available and the invite never echoes', async () => {
  const f = fixture();
  await f.send('/city Київ');
  assert.match(f.last().text, /приватний бот/);
  assert.equal(f.providerCalls.length, 0);
  await f.send('/id');
  assert.equal(f.last().text, 'Ваш Telegram ID: 11');
  await f.send('/start incorrect');
  assert.equal(f.saves(), 0);
  await f.send('/start@mappi_bot friends-secret');
  assert.deepEqual(f.store.users['11'], { favorites: [] });
  assert.equal(f.saves(), 1);
  assert.equal(f.last().reply_markup.keyboard[0][0].request_location, true);
  assert.match(f.last().text, /Київ/);
  assert.ok(!JSON.stringify(f.sent).includes('friends-secret'));
  await f.send('/city вокзал, Львів');
  assert.deepEqual(f.providerCalls[0], ['searchPlaces', 'вокзал, Львів']);
});

test('configured users are allowed without saving their search or geographic position', async () => {
  const f = fixture({ allowedUserIds: [11] });
  await f.send('Контрактова площа');
  assert.deepEqual(f.providerCalls[0], ['searchPlaces', 'Контрактова площа, Київ']);
  await f.click(f.token());
  assert.deepEqual(f.providerCalls[1], ['nearbyStops', PLACE.lat, PLACE.lon]);
  assert.deepEqual(f.store.users, {});
  assert.equal(f.saves(), 0);
  await f.send('', 11, { location: { latitude: 50.5, longitude: 30.5 } });
  assert.deepEqual(f.providerCalls.at(-1), ['nearbyStops', 50.5, 30.5]);
  assert.equal(f.saves(), 0);
});

test('callback values are opaque, confined to their user and expire after fifteen minutes', async () => {
  const f = fixture({ allowedUserIds: [11, 22] });
  await f.send('/city Київ');
  const token = f.token();
  assert.match(token, /^m:[A-Za-z0-9_-]{16}$/);
  assert.ok(!token.includes(String(PLACE.lat)));
  await f.click(token, 22);
  assert.equal(f.last().method, 'answerCallbackQuery');
  assert.match(f.last().text, /належить іншому користувачу/);
  assert.equal(f.providerCalls.length, 1);
  f.advance(15 * 60 * 1000);
  await f.click(token);
  assert.match(f.last().text, /застаріла/);
  assert.equal(f.providerCalls.length, 1);
  await f.click('m:forged');
  assert.match(f.last().text, /застаріла/);
});

test('favorites are saved only explicitly, open as venues, can be removed, and forget clears old callbacks', async () => {
  const f = fixture();
  await f.send('/start friends-secret');
  await f.send('', 11, { location: { latitude: STOP.lat, longitude: STOP.lon } });
  await f.click(f.token());
  const venue = f.sent.find((item) => item.method === 'sendVenue');
  assert.equal(venue.latitude, STOP.lat);
  assert.deepEqual(f.providerCalls.at(-1), ['stopRoutes', { id: STOP.id, name: STOP.name, lat: STOP.lat, lon: STOP.lon, mode: STOP.mode }]);
  assert.equal(f.store.users['11'].favorites.length, 0);
  await f.click(f.token());
  assert.equal(f.store.users['11'].favorites.length, 1);
  assert.equal(f.saves(), 2);
  assert.ok(!Object.hasOwn(f.store.users['11'].favorites[0], 'distance'));
  await f.send('/favorites');
  const favoriteToken = f.token();
  const removeToken = f.token(0, 1);
  await f.click(removeToken);
  assert.equal(f.store.users['11'].favorites.length, 0);
  await f.send('/forget');
  assert.deepEqual(f.store.users, {});
  assert.equal(f.last().reply_markup.remove_keyboard, true);
  await f.send('/start friends-secret');
  await f.click(favoriteToken);
  assert.match(f.last().text, /застаріла/);
});

test('forget erases persisted favorites and session data for configured users too', async () => {
  const f = fixture({ allowedUserIds: [11], store: { users: { 11: { favorites: [STOP] } } } });
  await f.send('/favorites');
  const token = f.token();
  await f.send('/forget');
  assert.equal(f.store.users['11'], undefined);
  await f.click(token);
  assert.match(f.last().text, /застаріла/);
  await f.send('/favorites');
  assert.match(f.last().text, /порожнє/);
});

test('favorites are bounded to twenty and provider outage does not block saving a found stop', async () => {
  const f = fixture({
    allowedUserIds: [11],
    store: { users: { 11: { favorites: Array.from({ length: 20 }, (_, i) => ({ ...STOP, id: `node/${i}` })) } } },
    providers: { stopRoutes: async () => { throw new Error('secret provider response'); } },
  });
  await f.send('', 11, { location: { latitude: STOP.lat, longitude: STOP.lon } });
  await f.click(f.token());
  assert.match(f.last().text, /маршрути зараз недоступні/);
  await f.click(f.token());
  assert.match(f.last().text, /вже 20/);
  assert.equal(f.store.users['11'].favorites.length, 20);
  assert.ok(!JSON.stringify(f.sent).includes('secret provider response'));
});

test('empty or stale GPS feed makes no live claim and never fabricates an arrival estimate', async () => {
  const f = fixture({ allowedUserIds: [11], providers: {
    liveKyiv: async () => ({ vehicles: [
      { ...STOP, route: '1', updatedAt: '2020-01-01T00:00:00Z' },
      { ...STOP, route: '2', updatedAt: null },
      { ...STOP, route: '3' },
    ], fetchedAt: new Date().toISOString() }),
  } });
  await f.send('/live');
  assert.match(f.last().text, /Немає свіжих GPS/);
  assert.ok(!f.sent.some((item) => item.method === 'sendVenue'));
  const empty = fixture({ allowedUserIds: [11] });
  await empty.send('🚌 GPS Київ');
  assert.match(empty.last().text, /Немає свіжих GPS/);
});

test('fresh GPS sends at most eight choices with its own timestamp and refuses a later stale selection', async () => {
  let routeReceived;
  let timestamp;
  const f = fixture({ allowedUserIds: [11], providers: {
    liveKyiv: async (route) => {
      routeReceived = route;
      timestamp = new Date(f.now() - 5000).toISOString();
      return { vehicles: Array.from({ length: 12 }, (_, index) => ({ ...STOP, id: `${index}`, name: `Машина ${index}`, route: '104', updatedAt: timestamp })) };
    },
  } });
  await f.send('/live 104');
  assert.equal(routeReceived, '104');
  assert.equal(f.last().reply_markup.inline_keyboard.length, 8);
  assert.match(f.last().text, /частину транспорту/);
  const nextToken = f.token(1);
  await f.click(f.token());
  assert.equal(f.last().method, 'sendVenue');
  assert.match(f.last().address, /GPS станом на/);
  assert.match(f.last().address, /Без прогнозу прибуття/);
  assert.match(f.last().title, /Київ/);
  f.advance(180_000);
  await f.click(nextToken);
  assert.match(f.last().text, /вже застаріла/);
});

test('non-private messages are ignored and private rate limits preserve /id and /start', async () => {
  const f = fixture({ allowedUserIds: [11] });
  await f.bot.handleUpdate({ message: { from: { id: 11 }, chat: { id: -22, type: 'group' }, text: '/start' } });
  assert.equal(f.sent.length, 0);
  await f.bot.handleUpdate(f.message(11, '/city Київ'));
  await f.bot.handleUpdate(f.message(11, '/city Львів'));
  assert.equal(f.providerCalls.length, 1);
  await f.bot.handleUpdate(f.message(11, '/id'));
  assert.equal(f.last().text, 'Ваш Telegram ID: 11');
  await f.bot.handleUpdate(f.message(11, '/start'));
  assert.ok(f.last().reply_markup.keyboard);
});

test('provider errors stay concise and plain text; failed persistence does not grant access', async () => {
  const f = fixture({ allowedUserIds: [11], providers: { searchPlaces: async () => { throw new Error('credential-sensitive upstream payload'); } } });
  await f.send('/city Київ');
  assert.match(f.last().text, /тимчасово недоступний/);
  assert.ok(!JSON.stringify(f.sent).includes('credential-sensitive'));
  assert.ok(f.sent.every((item) => !Object.hasOwn(item, 'parse_mode')));
  const failed = fixture({ store: { save: async () => { throw new Error('disk error'); } } });
  await failed.send('/start friends-secret');
  assert.deepEqual(failed.store.users, {});
  await failed.send('/city Київ');
  assert.match(failed.last().text, /приватний бот/);
  assert.equal(failed.providerCalls.length, 0);
});

test('transport errors propagate to polling retries and callback actions survive a failed send', async () => {
  let failVenue = true;
  const sent = [];
  const failure = new TelegramError('network');
  const f = fixture({ allowedUserIds: [11], telegram: { call: async (method, payload) => {
    if (method === 'sendVenue' && failVenue) throw failure;
    sent.push({ method, ...payload });
    return {};
  } } });
  await f.send('', 11, { location: { latitude: STOP.lat, longitude: STOP.lon } });
  const token = sent.at(-1).reply_markup.inline_keyboard[0][0].callback_data;
  await assert.rejects(f.click(token), (error) => error === failure);
  failVenue = false;
  await f.click(token);
  assert.ok(sent.some((item) => item.method === 'sendVenue'));
  assert.match(sent.at(-1).text, /Маршрути/);
});

test('merged stop references survive explicit saving and invalid references are discarded', async () => {
  const merged = { ...STOP, osmIds: ['node/123', 'way/456', 'node/123', '../private', 'node/1);out;', 25] };
  const f = fixture({ allowedUserIds: [11], providers: { nearbyStops: async () => [merged] } });
  await f.send('', 11, { location: { latitude: STOP.lat, longitude: STOP.lon } });
  await f.click(f.token());
  assert.deepEqual(f.providerCalls.at(-1)[1].osmIds, ['node/123', 'way/456']);
  await f.click(f.token());
  assert.deepEqual(f.store.users['11'].favorites[0].osmIds, ['node/123', 'way/456']);
});

test('confirmed public route numbers and unmapped technical IDs receive distinct labels', async () => {
  const f = fixture({ allowedUserIds: [11], providers: { liveKyiv: async () => ({ vehicles: [
    { ...STOP, id: 'vehicle1', route: '104', routeIsPublicNumber: true, updatedAt: new Date(f.now()).toISOString() },
    { ...STOP, id: 'vehicle2', route: '4567', routeIsPublicNumber: false, updatedAt: new Date(f.now()).toISOString() },
  ] }) } });
  await f.send('/live');
  const buttons = f.last().reply_markup.inline_keyboard;
  assert.match(buttons[0][0].text, /^Маршрут 104/);
  assert.match(buttons[1][0].text, /^ID маршруту 4567/);
  await f.click(buttons[0][0].callback_data);
  assert.match(f.last().title, /Маршрут 104/);
});

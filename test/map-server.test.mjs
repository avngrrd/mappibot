import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createMapServer, validateInitData } from '../src/map-server.mjs';
import { createBot } from '../src/bot.mjs';

const NOW = Date.parse('2026-09-12T12:00:00Z');
const BOT_TOKEN = '123456789:TEST_ONLY_NOT_A_REAL_BOT_TOKEN';
const PREVIEW_KEY = 'test-preview-key-with-at-least-thirty-two-characters';
const USER_ID = 77;
const ROUTE = { id: 'relation/123', ref: '62', name: 'Контрактова → Ботанічний', from: 'Контрактова', to: 'Ботанічний', mode: 'bus', operator: 'Київпастранс', url: 'https://www.openstreetmap.org/relation/123' };

// Independent test signer follows Telegram's bot-token HMAC protocol. The
// signature field remains in this check string; only third-party Ed25519
// validation omits both hash and signature.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function signedInitData({ authDate = NOW / 1_000, user = { id: USER_ID, first_name: 'Тест', photo_url: 'https://example.org/photo.jpg' }, fields = {} } = {}) {
  const values = {
    user: JSON.stringify(user), query_id: 'TEST_QUERY', auth_date: String(authDate),
    signature: 'TEST_ED25519_SIGNATURE_KEPT_IN_HMAC', ...fields,
  };
  const check = Object.keys(values).sort().map(key => `${key}=${values[key]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...values, hash }).toString();
}

async function setup(context, options = {}) {
  let clock = NOW;
  const calls = [];
  const store = options.store || { users: { [USER_ID]: { favorites: [] } }, async save() {} };
  const providers = {
    async liveKyiv() { calls.push(['live']); return { vehicles: [], source: 'test', fetchedAt: new Date(clock).toISOString(), staleCount: 0 }; },
    async nearbyStops(lat, lon) { calls.push(['stops', lat, lon]); return [{ id: 'node/1', name: 'Зупинка', lat, lon }]; },
    async searchPlaces(q) { calls.push(['search', q]); return [{ id: 'node/2', name: 'Місце', lat: 50.45, lon: 30.52 }]; },
    ...options.providers,
  };
  const mapData = {
    async listRoutes() { calls.push(['routes']); return [ROUTE]; },
    async routeGeometry(id) { calls.push(['geometry', id]); return { ...ROUTE, lines: [[[50.45, 30.52], [50.46, 30.53]]], stops: [], fetchedAt: new Date(clock).toISOString() }; },
    ...options.mapData,
  };
  const server = createMapServer({
    botToken: BOT_TOKEN, previewKey: PREVIEW_KEY, store, providers, mapData,
    allowedUserIds: options.allowedUserIds || [], now: () => clock,
    ...options.serverOptions,
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (pathname, { token, ...init } = {}) => fetch(origin + pathname, {
    ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers }, signal: AbortSignal.timeout(4_000),
  });
  const auth = async (body = { initData: signedInitData() }) => {
    const response = await request('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { response, body: await response.json() };
  };
  return { server, store, providers, calls, request, auth, setTime: value => { clock = value; } };
}

test('valid signed initData includes signature and Unicode user fields in HMAC validation', () => {
  const raw = signedInitData();
  assert.equal(validateInitData(raw, BOT_TOKEN, NOW), String(USER_ID));
  const tamperedSignature = new URLSearchParams(raw);
  tamperedSignature.set('signature', 'ALTERED_SIGNATURE');
  assert.equal(validateInitData(tamperedSignature.toString(), BOT_TOKEN, NOW), null);
  assert.equal(validateInitData(raw, 'different-test-token', NOW), null);
});

test('initData rejects tampering, stale/future times, duplicate fields and invalid user IDs', () => {
  const raw = signedInitData();
  const changedUser = new URLSearchParams(raw);
  changedUser.set('user', JSON.stringify({ id: 999 }));
  const badHash = new URLSearchParams(raw);
  badHash.set('hash', 'z'.repeat(64));
  for (const candidate of [
    changedUser.toString(), badHash.toString(), raw + '&auth_date=' + NOW / 1_000,
    raw + '&%75ser=' + encodeURIComponent(JSON.stringify({ id: USER_ID })),
    signedInitData({ authDate: NOW / 1_000 - 3_601 }), signedInitData({ authDate: NOW / 1_000 + 61 }),
    signedInitData({ authDate: 0 }), signedInitData({ user: { id: '77' } }), signedInitData({ user: { id: -1 } }),
    signedInitData({ fields: { user: '{invalid' } }), 'x'.repeat(16_385), '', null,
  ]) assert.equal(validateInitData(candidate, BOT_TOKEN, NOW), null);
  assert.equal(validateInitData(signedInitData({ authDate: NOW / 1_000 - 3_600 }), BOT_TOKEN, NOW), String(USER_ID));
  assert.equal(validateInitData(signedInitData({ authDate: NOW / 1_000 + 60 }), BOT_TOKEN, NOW), String(USER_ID));
});

test('loopback and forged headers never bypass API auth; unsigned/uninvited users are denied', async context => {
  const app = await setup(context);
  for (const pathname of ['/api/live', '/api/routes', '/api/route?id=relation%2F123', '/api/stops?lat=50.45&lon=30.52', '/api/search?q=Київ']) {
    const response = await app.request(pathname, { headers: { 'X-Forwarded-For': '127.0.0.1', 'X-User-Id': String(USER_ID) } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(app.calls.length, 0);
  assert.equal((await app.auth({ user: { id: USER_ID } })).response.status, 403);
  assert.equal((await app.auth({ initData: signedInitData({ user: { id: 999 } }) })).response.status, 403);
  assert.equal((await app.auth({ initData: 'invalid' })).response.status, 403);
});

test('authorized routes, geometry, places and nearby stops use validated inputs', async context => {
  const app = await setup(context);
  const login = await app.auth();
  assert.equal(login.response.status, 200);
  assert.deepEqual(Object.keys(login.body), ['token']);
  assert.match(login.body.token, /^[A-Za-z0-9_-]{43}$/);
  const token = login.body.token;
  const routes = await app.request('/api/routes', { token });
  assert.equal(routes.status, 200);
  assert.deepEqual(await routes.json(), { routes: [ROUTE] });
  const geometry = await app.request('/api/route?id=relation%2F123', { token });
  assert.equal(geometry.status, 200);
  assert.equal((await geometry.json()).id, 'relation/123');
  assert.equal((await app.request('/api/stops?lat=50.45&lon=30.52', { token })).status, 200);
  assert.equal((await app.request('/api/search?q=' + encodeURIComponent('Контрактова площа'), { token })).status, 200);
  assert.deepEqual(app.calls, [['routes'], ['geometry', 'relation/123'], ['stops', 50.45, 30.52], ['search', 'Контрактова площа, Київ']]);
  for (const pathname of ['/api/route?id=relation%2F1%29%3Bout%3B', '/api/route?id=way%2F123', '/api/stops?lat=50.45', '/api/stops?lat=Infinity&lon=30', '/api/stops?lat=0&lon=0', '/api/search?q=x']) {
    assert.equal((await app.request(pathname, { token })).status, 400);
  }
  assert.equal((await app.request('/api/routes', { token, method: 'POST' })).status, 405);
  assert.equal(app.calls.length, 4);
});

test('preview requires its explicit long secret and both preview/user sessions expire', async context => {
  const app = await setup(context, { store: { users: {}, async save() {} }, allowedUserIds: [USER_ID] });
  assert.equal((await app.auth({ previewKey: 'wrong' })).response.status, 403);
  const preview = await app.auth({ previewKey: PREVIEW_KEY });
  assert.equal(preview.response.status, 200);
  assert.equal((await app.request('/api/routes', { token: preview.body.token })).status, 200);
  const user = await app.auth();
  assert.equal(user.response.status, 200);
  app.setTime(NOW + 4 * 3_600_000 + 1);
  assert.equal((await app.request('/api/routes', { token: preview.body.token })).status, 401);
  assert.equal((await app.request('/api/routes', { token: user.body.token })).status, 401);
  const short = await setup(context, { serverOptions: { previewKey: 'short' } });
  assert.equal((await short.auth({ previewKey: 'short' })).response.status, 403);
});

test('/forget revokes every old bearer, including after rejoining and for an allowlisted user', async context => {
  for (const allowedUserIds of [[], [USER_ID]]) {
    const app = await setup(context, { allowedUserIds });
    const first = await app.auth();
    const second = await app.auth();
    const messages = [];
    const bot = createBot({
      telegram: { async call(method, body) { messages.push([method, body]); return true; } },
      providers: app.providers, store: app.store, allowedUserIds,
      inviteCode: 'test-only-invite-secret', now: () => NOW,
      onForget: id => app.server.revokeUser(id),
    });
    await bot.handleUpdate({ update_id: 1, message: { message_id: 1, text: '/forget', from: { id: USER_ID }, chat: { id: USER_ID, type: 'private' } } });
    assert.equal(Object.hasOwn(app.store.users, String(USER_ID)), false);
    assert.equal((await app.request('/api/routes', { token: first.body.token })).status, 401);
    // Simulate a new successful invitation. An old, not-yet-used bearer must
    // remain revoked rather than becoming valid again with the new membership.
    app.store.users[USER_ID] = { favorites: [] };
    assert.equal((await app.request('/api/routes', { token: second.body.token })).status, 401);
    assert.equal((await app.auth()).response.status, 200);
    assert.ok(messages.some(([, body]) => body.text?.includes('видалено')));
  }
});

test('static allowlist rejects traversal and private files, and provider errors cannot leak secrets', async context => {
  const marker = 'PRIVATE_UPSTREAM_VALUE_DO_NOT_RETURN';
  const app = await setup(context, { providers: { async liveKyiv() { throw new Error(`https://example.test/?token=${marker}`); } } });
  for (const pathname of ['/.env', '/../.env', '/%2e%2e/.env', '/%2e%2e%2f.env', '/src/main.mjs', '/data/state.json', '/vendor/leaflet/../../../.env', '/package.json']) {
    const response = await app.request(pathname);
    assert.equal(response.status, 404);
    const body = await response.text();
    assert.ok(!body.includes('TELEGRAM_BOT_TOKEN'));
    assert.ok(!body.includes(BOT_TOKEN));
  }
  const login = await app.auth();
  const response = await app.request('/api/live', { token: login.body.token });
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes(marker));
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.match(response.headers.get('content-security-policy'), /object-src 'none'/);
});

test('auth rejects oversized bodies and wrong media type without creating a session', async context => {
  const app = await setup(context);
  const wrongType = await app.request('/api/auth', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 415);
  const oversized = await app.request('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: 'x'.repeat(24_001) }) });
  assert.equal(oversized.status, 413);
});

const JOURNEY = {
  from: { lat: 50.45, lon: 30.52 }, to: { lat: 50.46, lon: 30.53 },
  modes: ['bus', 'subway'], maxTransfers: 1, sort: 'transfers',
};
const STATION = { id: 'mr10_119', name: 'Театральна', lat: 50.445, lon: 30.518, line: 'Святошинсько-Броварська' };
const SCHEDULE_CATALOG = {
  systems: [
    { id: 'metro', name: 'Метро', stations: [STATION] },
    { id: 'rail', name: 'Міська електричка', stations: [{ id: 'rail01', name: 'Вокзальна', lat: 50.44, lon: 30.49 }] },
    { id: 'funicular', name: 'Фунікулер', stations: [{ id: 'fn01', name: 'Верхня', lat: 50.456, lon: 30.522 }] },
  ], source: 'Official test source', fetchedAt: new Date(NOW).toISOString(),
};
const postJson = (token, body) => ({ token, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('all new APIs require a live bearer before reading inputs or calling services', async context => {
  const calls = [];
  const app = await setup(context, {
    providers: { async stopRoutes() { calls.push('stopRoutes'); return []; } },
    serverOptions: {
      planner: { async plan() { calls.push('plan'); return {}; } },
      schedules: {
        async catalog() { calls.push('catalog'); return SCHEDULE_CATALOG; },
        async timetable() { calls.push('timetable'); return {}; },
      },
      easyway: { configured: true, async status() { calls.push('easyway'); return {}; } },
    },
  });
  const endpoints = [
    ['/api/capabilities', {}],
    ['/api/journeys', postJson(undefined, JOURNEY)],
    ['/api/stop-routes', postJson(undefined, { stop: { id: 'node/1', osmIds: ['node/1', 'way/2'] } })],
    ['/api/schedules/catalog', {}],
    ['/api/schedules?system=metro&station=mr10_119', {}],
  ];
  for (const [pathname, init] of endpoints) {
    const response = await app.request(pathname, { ...init, headers: { ...init.headers, 'X-Forwarded-For': '127.0.0.1', 'X-User-Id': String(USER_ID) } });
    assert.equal(response.status, 401, pathname);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const { body: { token } } = await app.auth();
  app.setTime(NOW + 4 * 3_600_000 + 1);
  for (const [pathname, init] of endpoints) assert.equal((await app.request(pathname, { ...init, token })).status, 401, pathname);
  assert.deepEqual(calls, []);
});

test('journey API forwards only validated coordinates and deduplicated supported modes', async context => {
  const calls = [], result = { plans: [], source: 'Test topology', notice: 'No arrival forecast' };
  const app = await setup(context, { serverOptions: { planner: { async plan(query) { calls.push(query); return result; } } } });
  const { body: { token } } = await app.auth();
  const response = await app.request('/api/journeys', postJson(token, {
    ...JOURNEY,
    from: { ...JOURNEY.from, name: 'Private address', url: 'https://untrusted.invalid/' },
    to: { ...JOURNEY.to, token: 'PRIVATE_VALUE' },
    modes: ['bus', 'subway', 'bus'], url: 'https://untrusted.invalid/', login: 'PRIVATE_VALUE',
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.deepEqual(calls, [JOURNEY]);
  const boundary = {
    from: { lat: 50.2, lon: 30.2 }, to: { lat: 50.7, lon: 30.9 },
    modes: ['bus', 'trolleybus', 'tram', 'subway', 'light_rail'], maxTransfers: 0, sort: 'walk',
  };
  assert.equal((await app.request('/api/journeys', postJson(token, boundary))).status, 200);
  assert.deepEqual(calls[1], boundary);
  assert.equal((await app.request('/api/journeys', { token })).status, 405);
  assert.equal(calls.length, 2);
});

test('journey API rejects malformed, out-of-city and unsupported requests before planning', async context => {
  let planned = 0;
  const app = await setup(context, { serverOptions: { planner: { async plan() { planned++; return {}; } } } });
  const { body: { token } } = await app.auth();
  const invalid = [
    null, [], {}, { ...JOURNEY, from: null }, { ...JOURNEY, to: [] },
    ...[
      { lat: '50.45', lon: 30.52 }, { lat: null, lon: 30.52 }, { lat: 50.45 },
      { lat: 50.1999, lon: 30.52 }, { lat: 50.7001, lon: 30.52 },
      { lat: 50.45, lon: 30.1999 }, { lat: 50.45, lon: 30.9001 },
      { lat: 49.84, lon: 24.03 },
    ].flatMap(point => [{ ...JOURNEY, from: point }, { ...JOURNEY, to: point }]),
    ...[null, [], 'bus', ['train'], ['bus', 'foot'], [null], Array(6).fill('bus')].map(modes => ({ ...JOURNEY, modes })),
    ...[-1, 2, '1', null, true].map(maxTransfers => ({ ...JOURNEY, maxTransfers })),
    ...['fastest', '', null, []].map(sort => ({ ...JOURNEY, sort })),
  ];
  for (const body of invalid) assert.equal((await app.request('/api/journeys', postJson(token, body))).status, 400, JSON.stringify(body));
  // Valid JSON can encode a number outside JavaScript's finite range.
  const infinite = await app.request('/api/journeys', { ...postJson(token, JOURNEY), body: JSON.stringify(JOURNEY).replace('50.45', '1e999') });
  assert.equal(infinite.status, 400);
  const malformed = await app.request('/api/journeys', { ...postJson(token, {}), body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await app.request('/api/journeys', { ...postJson(token, {}), headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await app.request('/api/journeys', postJson(token, { ...JOURNEY, extra: 'x'.repeat(24_001) }))).status, 413);
  assert.equal(planned, 0);
});

test('POST stop-routes preserves merged OSM platform IDs while blocking query injection and oversized sets', async context => {
  const calls = [];
  const app = await setup(context, { providers: { async stopRoutes(stop) { calls.push(stop); return [ROUTE]; } } });
  const { body: { token } } = await app.auth();
  const stop = { id: 'node/1', osmIds: ['node/1', 'node/2', 'way/3', 'relation/4'] };
  const response = await app.request('/api/stop-routes', postJson(token, { stop: { ...stop, name: 'Private place', lat: 50.45, lon: 30.52 }, url: 'https://untrusted.invalid/' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { routes: [ROUTE] });
  assert.deepEqual(calls, [stop]);
  assert.equal((await app.request('/api/stop-routes', postJson(token, { stop: { id: 'way/5' } }))).status, 200);
  assert.deepEqual(calls[1], { id: 'way/5' });
  const invalidIds = [1, '', 'node/0', 'node/-1', 'node/1);out;', 'node/1000000000000000', 'https://example.org/node/1', 'relation/1\n'];
  for (const id of invalidIds) {
    assert.equal((await app.request('/api/stop-routes', postJson(token, { stop: { id } }))).status, 400);
    assert.equal((await app.request('/api/stop-routes', postJson(token, { stop: { id: 'node/1', osmIds: [id] } }))).status, 400);
  }
  for (const osmIds of [null, 'node/1', {}, Array(21).fill('node/1')]) {
    assert.equal((await app.request('/api/stop-routes', postJson(token, { stop: { id: 'node/1', osmIds } }))).status, 400);
  }
  assert.equal((await app.request('/api/stop-routes', postJson(token, {}))).status, 400);
  assert.equal((await app.request('/api/stop-routes', { token })).status, 405);
  assert.equal(calls.length, 2);
});

test('schedule API restricts station IDs to the chosen catalog and never forwards arbitrary upstream URLs', async context => {
  const calls = [];
  const result = {
    system: 'metro', station: STATION,
    directions: [{ id: 'forward', name: 'Прямий', first: '05:48', last: '23:05', intervals: [{ days: 'Робочі дні', period: '05:30–07:00', minutes: null, label: '7:30-5:30 хв:сек' }] }],
    source: SCHEDULE_CATALOG.source, fetchedAt: SCHEDULE_CATALOG.fetchedAt, notice: 'Опублікований розклад, не прогноз прибуття.',
  };
  const app = await setup(context, { serverOptions: { schedules: {
    async catalog() { calls.push(['catalog']); return SCHEDULE_CATALOG; },
    async timetable(...args) { calls.push(['timetable', ...args]); return result; },
  } } });
  const { body: { token } } = await app.auth();
  const catalog = await app.request('/api/schedules/catalog', { token });
  assert.equal(catalog.status, 200);
  assert.deepEqual(await catalog.json(), SCHEDULE_CATALOG);
  const timetable = await app.request('/api/schedules?system=metro&station=mr10_119&url=https%3A%2F%2Funtrusted.invalid%2F&layer=99', { token });
  assert.equal(timetable.status, 200);
  assert.deepEqual(await timetable.json(), result);
  assert.deepEqual(calls, [['catalog'], ['catalog'], ['timetable', 'metro', 'mr10_119']]);
  // Valid-looking IDs may only be used with the system that actually owns them.
  for (const query of ['system=metro&station=rail01', 'system=rail&station=mr10_119', 'system=funicular&station=unknown']) {
    assert.equal((await app.request('/api/schedules?' + query, { token })).status, 400);
  }
  const beforeMalformed = calls.length;
  for (const query of [
    '', 'system=bus&station=mr10_119', 'system=metro', 'system=metro&station=..%2F13%2Fquery',
    'system=metro&station=https%3A%2F%2Funtrusted.invalid', 'system=metro&station=mr10_119%27%20OR%201%3D1',
    'system=metro&station=' + 'a'.repeat(41),
  ]) assert.equal((await app.request('/api/schedules?' + query, { token })).status, 400);
  assert.equal(calls.length, beforeMalformed, 'malformed IDs must not fetch even the catalog');
  assert.equal(calls.filter(([name]) => name === 'timetable').length, 1);
  assert.equal((await app.request('/api/schedules/catalog', postJson(token, {}))).status, 405);
  assert.equal((await app.request('/api/schedules?system=metro&station=mr10_119', postJson(token, {}))).status, 405);
});

test('capabilities never expose EasyWay credentials, permissions or an unverified connected state', async context => {
  const marker = 'PRIVATE_EASYWAY_CREDENTIAL_OR_ACCOUNT_PAYLOAD';
  let checked = 0;
  const app = await setup(context, { serverOptions: {
    planner: { plan() {} }, schedules: { catalog() {}, timetable() {} },
    easyway: { configured: true, connected: true, login: marker, password: marker, permissions: marker,
      status() { checked++; throw new Error(marker); } },
  } });
  const { body: { token } } = await app.auth();
  const response = await app.request('/api/capabilities', { token });
  assert.equal(response.status, 200);
  const text = await response.text(), data = JSON.parse(text);
  assert.equal(data.journeys, true);
  assert.equal(data.schedules, true);
  assert.equal(data.easyway.configured, true);
  assert.equal(data.easyway.connected, false);
  assert.deepEqual(Object.keys(data.easyway).sort(), ['configured', 'connected', 'notice']);
  for (const secret of [marker, BOT_TOKEN, PREVIEW_KEY, token]) assert.ok(!text.includes(secret));
  assert.equal(checked, 0, 'capability reads must not perform credential checks or consume account quota');

  const unavailable = await setup(context);
  const { body: { token: secondToken } } = await unavailable.auth();
  const absent = await unavailable.request('/api/capabilities', { token: secondToken });
  const disabled = await absent.json();
  assert.equal(disabled.journeys, false);
  assert.equal(disabled.schedules, false);
  assert.equal(disabled.easyway.configured, false);
  assert.equal(disabled.easyway.connected, false);
  assert.equal((await unavailable.request('/api/journeys', postJson(secondToken, JOURNEY))).status, 503);
  assert.equal((await unavailable.request('/api/schedules/catalog', { token: secondToken })).status, 503);
  assert.equal((await unavailable.request('/api/schedules?system=metro&station=mr10_119', { token: secondToken })).status, 503);
});

test('new service failures return controlled errors without exposing provider requests or private points', async context => {
  const marker = 'PRIVATE_PROVIDER_REQUEST_OR_LOCATION';
  const fail = async () => { throw new Error(`https://upstream.invalid/?password=${marker}`); };
  const app = await setup(context, { providers: { stopRoutes: fail }, serverOptions: {
    planner: { plan: fail }, schedules: { catalog: async () => SCHEDULE_CATALOG, timetable: fail },
  } });
  const { body: { token } } = await app.auth();
  for (const [pathname, init] of [
    ['/api/journeys', postJson(token, JOURNEY)],
    ['/api/stop-routes', postJson(token, { stop: { id: 'node/1' } })],
    ['/api/schedules?system=metro&station=mr10_119', { token }],
  ]) {
    const response = await app.request(pathname, init);
    assert.equal(response.status, 503, pathname);
    assert.deepEqual(await response.json(), { error: 'Джерело даних зараз недоступне. Спробуйте ще раз.' });
  }
});

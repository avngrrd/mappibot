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

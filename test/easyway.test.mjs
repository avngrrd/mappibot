import test from 'node:test';
import assert from 'node:assert/strict';
import { createEasyWay, redactEasyWayUrl } from '../src/easyway.mjs';

const TIME = Date.UTC(2026, 8, 12, 11);
// Synthetic JSON fixtures use documented fields; no real account or live GPS.
const fixtures = {
  'user.GetMyInfo': { permission: [{ city: 'kyiv', function: '*', minute: { limit: 5 } }] },
  'cities.GetRoutesList': { routesList: [{ id: '21', title: '1А', start_position: 0, stop_position: 438, transport: 'bus' }] },
  'routes.GetRouteInfo': { route: { title: '1А', type: 'bus', interval: '10-15', work_time: '06:41 - 23:04' } },
  'routes.GetRouteGPS': { vehicle: [{ id: '191', lat: 50.44, lng: 30.52, direction: 1, data_relevance: 0 }] },
  'stops.GetStopInfo': { stop: { title: 'Зупинка', transports: [{ route: [{ id: '21', has_gps: 0, next_vehicle: '', second_vehicle: '' }] }] } },
  'routes.Search': { ways: [{ routes: [{ id: '21', start_position: 3, stop_position: 8, time: 12 }] }] }
};
function setup(overrides = {}) {
  const calls = [];
  let clock = TIME;
  const service = createEasyWay({ login: 'test-login', password: 'test-password', now: () => clock, fetchImpl: async (url, options) => {
    const parameters = new URL(url).searchParams;
    calls.push({ url, options, parameters });
    clock += 1_100;
    return new Response(JSON.stringify(fixtures[parameters.get('function')]));
  }, ...overrides });
  return { service, calls, advance: ms => { clock += ms; } };
}

test('missing credentials remain disconnected and perform no requests', async () => {
  let calls = 0;
  const service = createEasyWay({ fetchImpl: async () => { calls++; throw new Error(); } });
  assert.equal(service.configured, false);
  assert.equal((await service.status()).connected, false);
  await assert.rejects(service.routes(), { code: 'NOT_CONFIGURED' });
  assert.equal(calls, 0);
});

test('requires HTTPS with no embedded credentials, query, or redirect target', () => {
  for (const url of ['http://api.eway.in.ua/', 'https://name:secret@api.eway.in.ua/', 'https://api.eway.in.ua/?password=x']) {
    assert.throws(() => createEasyWay({ url }), { code: 'INVALID_CONFIG' });
  }
  assert.throws(() => createEasyWay({ language: 'unknown' }), { code: 'INVALID_CONFIG' });
});

test('an unrecognized account JSON response does not pretend access was verified', async () => {
  const { service } = setup({ fetchImpl: async () => new Response('{}') });
  const result = await service.status();
  assert.equal(result.configured, true);
  assert.equal(result.connected, false);
  assert.equal(result.code, 'UNVERIFIED_SCHEMA');
});

test('uses the documented protocol and preserves JSON fields without guessing casing or ETA', async () => {
  const { service, calls } = setup();
  assert.equal((await service.status()).connected, true);
  assert.deepEqual((await service.routes()).data, fixtures['cities.GetRoutesList']);
  assert.deepEqual((await service.route('21')).data, fixtures['routes.GetRouteInfo']);
  assert.deepEqual((await service.stop('42')).data, fixtures['stops.GetStopInfo']);
  const gps = await service.gps(['21', '21']);
  assert.equal(gps.routes.length, 1);
  assert.equal(gps.routes[0].data.vehicle[0].data_relevance, 0);
  assert.ok(!('updatedAt' in gps.routes[0].data.vehicle[0]));
  for (const call of calls) {
    assert.equal(call.parameters.get('login'), 'test-login');
    assert.equal(call.parameters.get('password'), 'test-password');
    assert.equal(call.parameters.get('format'), 'json');
    assert.equal(call.parameters.get('v'), '1.0');
    assert.equal(call.parameters.get('lang'), 'ua');
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal);
  }
});

test('constructs journey queries from an allowlist and rejects ID/parameter injection', async () => {
  const { service, calls } = setup();
  for (const id of ['21&function=other', '../21', '21?password=evil']) assert.throws(() => service.route(id), { code: 'INVALID_INPUT' });
  const query = { start_lat: 50.44, start_lng: 30.52, stop_lat: 50.46, stop_lng: 30.55, transports: ['bus', 'metro'], direct: true, results_count: 2, login: 'evil', password: 'evil', function: 'evil' };
  const result = await service.searchJourney(query);
  assert.deepEqual(result.data, fixtures['routes.Search']);
  assert.equal(calls[0].parameters.get('function'), 'routes.Search');
  assert.equal(calls[0].parameters.get('login'), 'test-login');
  assert.equal(calls[0].parameters.get('transports'), 'bus,metro');
  assert.equal(calls[0].parameters.get('direct'), 'true');
  assert.throws(() => service.searchJourney({ ...query, start_lat: 0 }), { code: 'INVALID_INPUT' });
  assert.throws(() => service.searchJourney({ ...query, transports: ['spaceship'] }), { code: 'INVALID_INPUT' });
  assert.throws(() => service.searchJourney({ ...query, direct: 'false' }), { code: 'INVALID_INPUT' });
  await assert.rejects(service.gps(Array(6).fill('21')), { code: 'INVALID_INPUT' });
});

test('cache and concurrent deduplication preserve quota; callers cannot mutate cached data', async () => {
  const { service, calls, advance } = setup();
  const [first, second] = await Promise.all([service.routes(), service.routes()]);
  assert.equal(calls.length, 1);
  first.data.routesList[0].title = 'changed';
  assert.equal(second.data.routesList[0].title, '1А');
  assert.equal((await service.routes()).data.routesList[0].title, '1А');
  advance(300_000);
  await service.routes();
  assert.equal(calls.length, 2);
});

test('request pacing serializes uncached network calls', async () => {
  const starts = [];
  const { service } = setup({ now: Date.now, fetchImpl: async () => { starts.push(Date.now()); return new Response('{}'); } });
  await Promise.all([service.route('1'), service.route('2')]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 1_050);
});

test('does not expose credential-bearing fetch errors or upstream error messages', async () => {
  for (const fetchImpl of [
    async url => { throw new Error(`Failed GET ${url}`); },
    async () => new Response(JSON.stringify({ error: { code: 2, message: 'test-login test-password' } })),
    async () => new Response(JSON.stringify({ response: { error: { id: 1, message: 'test-password' } } }))
  ]) {
    const { service } = setup({ fetchImpl });
    await assert.rejects(service.routes(), error => !/test-login|test-password|password=/.test(error.message + error.stack));
  }
  const redacted = redactEasyWayUrl('https://api.eway.in.ua/?login=test-login&password=test-password&function=routes.Search');
  assert.doesNotMatch(redacted, /test-login|test-password/);
  assert.match(redacted, /routes.Search/);
});

test('limits response size, rejects non-JSON and removes unexpected secret fields', async () => {
  for (const body of ['<html>error</html>', 'x'.repeat(2_000_001)]) {
    const { service } = setup({ fetchImpl: async () => new Response(body) });
    await assert.rejects(service.routes());
  }
  const { service } = setup({ fetchImpl: async () => new Response(JSON.stringify({ route: { title: '1', password: 'test-password' }, login: 'test-login' })) });
  assert.deepEqual((await service.route('1')).data, { route: { title: '1' } });
});

test('quota/access rejection has a cooldown and never substitutes an expired GPS snapshot', async () => {
  let clock = TIME;
  let count = 0;
  let blocked = false;
  const { service } = setup({ now: () => clock, fetchImpl: async () => {
    count++; clock += 1_100;
    return blocked ? new Response('{}', { status: 429 }) : new Response(JSON.stringify(fixtures['routes.GetRouteGPS']));
  } });
  await service.gps(['21']);
  clock += 15_000; blocked = true;
  await assert.rejects(service.gps(['21']), { code: 'ACCESS_OR_QUOTA' });
  await assert.rejects(service.routes(), { code: 'ACCESS_OR_QUOTA' });
  assert.equal(count, 2);
});

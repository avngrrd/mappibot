import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapData } from '../src/map-data.mjs';
import { createProviders } from '../src/providers.mjs';

const NOW = Date.parse('2026-09-12T12:00:00Z');
const route = (id = 123, tags = {}) => ({ type: 'relation', id, tags: { type: 'route', route: 'bus', ref: '104', name: '104: Початок → Кінець', from: 'Початок', to: 'Кінець', operator: 'Київпастранс', ...tags } });
const payload = elements => ({ elements: [...elements, { type: 'count', id: 0, tags: { total: String(elements.length) } }] });
const reply = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const road = (id, coords) => ({ type: 'way', id, tags: { highway: 'residential' }, geometry: coords.map(([lat, lon]) => ({ lat, lon })) });
function geometry() {
  return payload([
    { ...route(), members: [
      { type: 'node', ref: 22, role: 'stop' }, { type: 'way', ref: 33, role: 'platform' },
      { type: 'node', ref: 11, role: 'stop_exit_only' },
      { type: 'way', ref: 101, role: '' }, { type: 'way', ref: 102, role: 'backward' },
    ] },
    { type: 'node', id: 11, lat: 50.42, lon: 30.43, tags: { name: 'Третя', public_transport: 'stop_position' } },
    { type: 'node', id: 22, lat: 50.4, lon: 30.4, tags: { name: 'Перша', highway: 'bus_stop' } },
    { ...road(33, [[50.405, 30.405], [50.415, 30.415]]), tags: { public_transport: 'platform', name: 'Друга' } },
    road(101, [[50.4, 30.4], [50.41, 30.41]]),
    road(102, [[50.55, 30.65], [50.54, 30.64]]),
  ]);
}

test('catalog is Kyiv-scoped, tag-only, counted and cached without sharing mutable results', async () => {
  let calls = 0;
  let query;
  const map = createMapData({ fetchImpl: async (_, options) => {
    calls += 1;
    query = new URLSearchParams(options.body).get('data');
    assert.equal(options.headers['Accept-Language'], 'uk');
    assert.ok(options.signal);
    return reply(payload([route(), route(124, { route: 'bicycle' }), route(125, { ref: '2' })]));
  } });
  const [first, concurrent] = await Promise.all([map.listRoutes(), map.listRoutes()]);
  assert.equal(calls, 1);
  assert.match(query, /relation\(50\.2,30\.2,50\.7,30\.9\)/);
  assert.match(query, /out tags 1001/);
  assert.match(query, /out count/);
  assert.ok(!query.includes('geom'));
  assert.deepEqual(first.map(item => item.ref), ['2', '104']);
  assert.equal(first[1].operator, 'Київпастранс');
  first[1].ref = 'mutated';
  assert.equal(concurrent[1].ref, '104');
  assert.equal((await map.listRoutes())[1].url, 'https://www.openstreetmap.org/relation/123');
});

test('geometry retains member stop order, represents way platforms and never connects disconnected ways', async () => {
  const queries = [];
  const map = createMapData({ now: () => NOW, fetchImpl: async (_, options) => {
    const query = new URLSearchParams(options.body).get('data');
    queries.push(query);
    return reply(query.includes('out tags') ? payload([route()]) : geometry());
  } });
  const result = await map.routeGeometry('relation/123');
  assert.deepEqual(result.stops.map(stop => stop.name), ['Перша', 'Друга', 'Третя']);
  assert.equal(result.stops[1].id, 'way/33');
  assert.ok(Math.abs(result.stops[1].lat - 50.41) < 1e-9);
  assert.equal(result.lines.length, 2);
  assert.deepEqual(result.lines[0], [[50.4, 30.4], [50.41, 30.41]]);
  assert.deepEqual(result.lines[1], [[50.54, 30.64], [50.55, 30.65]]);
  assert.equal(result.fetchedAt, new Date(NOW).toISOString());
  assert.match(queries[1], /node\(r\.route\);way\(r\.route\)/);
  result.lines[0][0][0] = 0;
  assert.equal((await map.routeGeometry('relation/123')).lines[0][0][0], 50.4);
  assert.equal(queries.length, 2);
});

test('arbitrary relation IDs and injected query syntax cannot bypass the Kyiv catalog', async () => {
  let calls = 0;
  const map = createMapData({ fetchImpl: async () => { calls += 1; return reply(payload([route()])); } });
  for (const id of ['relation/1);out;', 'way/123', 'relation/0', 123, 'relation/9999999999999999']) {
    await assert.rejects(map.routeGeometry(id), { code: 'INVALID_INPUT' });
  }
  assert.equal(calls, 0);
  await assert.rejects(map.routeGeometry('relation/999'), { code: 'NOT_FOUND' });
  assert.equal(calls, 1);
});

test('validated journey candidates remain drawable across stale catalogs without opening arbitrary relation lookup', async () => {
  let time = NOW;
  const queries = [];
  const map = createMapData({ now: () => time, fetchImpl: async (_, options) => {
    const query = new URLSearchParams(options.body).get('data');
    queries.push(query);
    return reply(query.includes('out tags') ? payload([]) : geometry());
  } });
  assert.deepEqual(await map.listRoutes(), []);
  const candidate = { id: 'relation/123', mode: 'bus', stops: [{ lat: 50.4, lon: 30.4 }, { lat: 50.42, lon: 30.43 }] };
  for (const invalid of [{ ...candidate, id: 'relation/123);out;' }, { ...candidate, mode: 'bicycle' },
    { ...candidate, stops: [{ lat: 49.8, lon: 24 }, { lat: 49.81, lon: 24.01 }] }]) {
    assert.throws(() => map.rememberCandidateRoutes([invalid]), { code: 'INVALID_INPUT' });
  }
  map.rememberCandidateRoutes([candidate]);
  assert.equal((await map.routeGeometry('relation/123')).id, 'relation/123');
  assert.equal(queries.length, 2);
  await assert.rejects(map.routeGeometry('relation/999'), { code: 'NOT_FOUND' });
  time += 3_600_001;
  await assert.rejects(map.routeGeometry('relation/123'), { code: 'NOT_FOUND' });
  assert.equal(queries.length, 3);
});

test('only adjacent matching stop-position/platform pairs merge; platforms, unknowns and loop repeats retain order', async () => {
  const nodes = [];
  const members = [];
  const add = (id, role, name, { publicTransport, lat = 50.45, lon = 30.52 } = {}) => {
    nodes.push({ type: 'node', id, lat, lon, tags: { highway: 'bus_stop', name, ...(publicTransport ? { public_transport: publicTransport } : {}) } });
    members.push({ type: 'node', ref: id, role });
  };
  add(10, 'stop', '  площа   Ринок ', { publicTransport: 'stop_position' });
  add(11, 'platform', 'Площа Ринок', { publicTransport: 'platform', lat: 50.4501, lon: 30.5201 });
  add(12, 'platform', 'Площа Ринок', { publicTransport: 'platform' });
  add(13, 'platform', 'Площа Ринок', { publicTransport: 'platform' });
  add(14, 'stop', 'Дві позиції', { publicTransport: 'stop_position' });
  add(15, 'stop', 'Дві позиції', { publicTransport: 'stop_position' });
  add(16, '', 'Невідома');
  add(17, 'platform', 'Невідома', { publicTransport: 'platform' });
  add(18, 'stop', 'Далека');
  add(19, 'platform', 'Далека', { lat: 50.452 });
  add(20, 'stop', 'Різна');
  add(21, 'platform', 'Інша');
  add(22, 'stop', 'Не поруч');
  add(23, 'stop', 'Проміжна');
  add(24, 'platform', 'Не поруч');
  add(25, 'stop', 'Перерва');
  members.push({ type: 'way', ref: 101, role: '' });
  add(26, 'platform', 'Перерва');
  add(27, 'stop', 'Суперечлива', { publicTransport: 'platform' });
  add(28, 'platform', 'Суперечлива', { publicTransport: 'platform' });
  add(29, '', 'За тегами', { publicTransport: 'stop_position' });
  add(30, '', 'За тегами', { publicTransport: 'platform' });
  // A route returning to its first stop must retain this second occurrence.
  members.push({ type: 'node', ref: 10, role: 'stop' }, { type: 'node', ref: 11, role: 'platform' });
  const data = payload([{ ...route(), members }, ...nodes, road(101, [[50.45, 30.52], [50.46, 30.53]])]);
  const map = createMapData({ fetchImpl: async (_, options) => reply(options.body.includes('out+tags') ? payload([route()]) : data) });
  const result = await map.routeGeometry('relation/123');
  assert.deepEqual(result.stops.map(stop => stop.id), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 30, 11].map(id => `node/${id}`));
  assert.deepEqual(result.stops[0], { id: 'node/11', name: 'Площа Ринок', lat: 50.4501, lon: 30.5201, osmIds: ['node/10', 'node/11'] });
  assert.deepEqual(result.stops.at(-1), result.stops[0]);
  assert.deepEqual(result.stops.at(-2).osmIds, ['node/29', 'node/30']);
  assert.ok(!Object.keys(result.stops[0]).some(key => key.startsWith('_')));
  assert.equal(result.lines.length, 1);
});

test('catalog refuses partial, uncounted and over-limit responses instead of reporting a complete list', async () => {
  for (const data of [
    { ...payload([route()]), remark: 'runtime error: timeout' },
    { elements: [route()] },
    { elements: [route(), { type: 'count', id: 0, tags: { total: '2' } }] },
    { elements: [{ type: 'count', id: 0, tags: { total: '1001' } }] },
  ]) {
    const map = createMapData({ fetchImpl: async () => reply(data) });
    await assert.rejects(map.listRoutes(), error => ['INVALID_RESPONSE', 'TOO_LARGE'].includes(error.code));
  }
});

test('geometry rejects missing ways and malformed points rather than bridging over gaps', async () => {
  for (const kind of ['missing', 'bad-point', 'outside-kyiv']) {
    const data = geometry();
    if (kind === 'missing') data.elements = data.elements.filter(item => item.id !== 101);
    if (kind === 'bad-point') data.elements.find(item => item.id === 101).geometry.splice(1, 0, null);
    if (kind === 'outside-kyiv') {
      for (const item of data.elements) {
        if (item.type === 'node') { item.lat = 49.84; item.lon = 24.03; }
        if (item.geometry) item.geometry = item.geometry.map(() => ({ lat: 49.84, lon: 24.03 }));
      }
    }
    data.elements.find(item => item.type === 'count').tags.total = String(data.elements.length - 1);
    const map = createMapData({ fetchImpl: async (_, options) => reply(options.body.includes('out+tags') ? payload([route()]) : data) });
    await assert.rejects(map.routeGeometry('relation/123'), { code: 'INVALID_RESPONSE' });
  }
});

test('one-hour TTL refreshes data; declared oversized HTTP bodies are rejected', async () => {
  let time = NOW;
  let calls = 0;
  const map = createMapData({ now: () => time, fetchImpl: async () => { calls += 1; return reply(payload([route()])); } });
  await map.listRoutes();
  time += 3_599_999;
  await map.listRoutes();
  assert.equal(calls, 1);
  time += 2;
  await map.listRoutes();
  assert.equal(calls, 2);
  const oversized = createMapData({ fetchImpl: async () => new Response('{}', { headers: { 'Content-Length': '8000001' } }) });
  await assert.rejects(oversized.listRoutes(), { code: 'TOO_LARGE' });
});

test('map and bot providers share the same serialized Overpass limiter', async () => {
  const calls = [];
  const map = createMapData({ fetchImpl: async () => { calls.push(Date.now()); return reply(payload([])); } });
  const bot = createProviders({ fetchImpl: async () => { calls.push(Date.now()); return reply({ elements: [] }); } });
  await Promise.all([map.listRoutes(), bot.nearbyStops(50.45, 30.52)]);
  assert.ok(calls[1] - calls[0] >= 1_090, `Expected >=1100ms pacing, got ${calls[1] - calls[0]}ms`);
});

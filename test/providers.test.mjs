import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders, distanceMeters, normalizeDnipro, validCoordinates } from '../src/providers.mjs';

const NOW = Date.parse('2026-09-12T09:41:10Z');
const point = overrides => ({ gps_id: '12345', bort_number: 'АЕ1234', type: 'bus', number: '177', lat: 48.4711, lon: 35.2074, timestamp: NOW / 1_000 - 15, ...overrides });
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const stop = (id, lat, tags = {}, type = 'node') => ({ type, id, ...(type === 'node' ? { lat, lon: 30.5 } : { center: { lat, lon: 30.5 } }), tags: { name: `Зупинка ${id}`, highway: 'bus_stop', ...tags } });

test('coordinates reject strings, non-finite and out-of-range values; distance is metric', () => {
  assert.equal(validCoordinates(50.45, 30.52), true);
  for (const pair of [[NaN, 0], [0, Infinity], [91, 0], [0, -181], ['50', 30], [null, 30]]) assert.equal(validCoordinates(...pair), false);
  assert.equal(distanceMeters(50, 30, 50, 30), 0);
  assert.ok(Math.abs(distanceMeters(50, 30, 50.001, 30) - 111.195) < 0.1);
});

test('Dnipro trusts each vehicle timestamp, excludes stale/invalid GPS, never uses fresh feed header as fallback', () => {
  const result = normalizeDnipro({ timestamp: NOW / 1_000, positions: [
    point(), point({ gps_id: 'old', timestamp: NOW / 1_000 - 181 }),
    point({ gps_id: 'boundary', timestamp: NOW / 1_000 - 180 }),
    point({ gps_id: 'missing', timestamp: undefined }), point({ gps_id: 'zero', timestamp: null }),
    point({ gps_id: 'gps-zero', lat: 0, lon: 0 }), point({ gps_id: 'other-city', lat: 50.45, lon: 30.52 }),
    point({ gps_id: 'bad-lat', lat: '' }), point({ gps_id: 'bad-lon', lon: true }),
    point({ gps_id: 'future', timestamp: NOW / 1_000 + 61 }), point({ gps_id: 'milliseconds', timestamp: NOW }),
  ] }, NOW);
  assert.deepEqual(result.vehicles.map(vehicle => vehicle.id), ['bus:177:12345', 'bus:177:boundary']);
  assert.equal(result.staleCount, 1);
  assert.equal(result.fetchedAt, new Date(NOW).toISOString());
  assert.equal(result.vehicles[0].updatedAt, new Date(NOW - 15_000).toISOString());
  assert.equal(result.source, 'https://data.gov.ua/dataset/real-transport-dnipro');
  assert.equal(normalizeDnipro({ timestamp: NOW / 1_000, positions: [point({ timestamp: undefined })] }, NOW).vehicles.length, 0);
});

test('Dnipro clamps <=60sec clock skew and deduplicates a vehicle using newest position', () => {
  const result = normalizeDnipro({ positions: [
    point(), point({ timestamp: NOW / 1_000 - 5, lat: 48.48 }),
    point({ gps_id: 'skew', type: 'trol', timestamp: NOW / 1_000 + 60 }),
  ] }, NOW);
  assert.equal(result.vehicles.length, 2);
  assert.equal(result.vehicles[0].lat, 48.48);
  assert.equal(result.vehicles[1].updatedAt, new Date(NOW).toISOString());
  assert.match(result.vehicles[1].name, /^Тролейбус 177/);
  assert.throws(() => normalizeDnipro({ vehicles: [] }, NOW), { code: 'INVALID_RESPONSE' });
});

test('search submits one full UA query, uses bounded results and shares cache for concurrent duplicate searches', async () => {
  const calls = [];
  const providers = createProviders({ fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options });
    return response([null, { osm_type: 'relation', osm_id: 123, display_name: 'Київ, Україна', lat: '50.45', lon: '30.52' }, { osm_type: 'node', osm_id: 456, display_name: 'Bad', lat: '', lon: 30 }]);
  } });
  const [first, second] = await Promise.all([providers.searchPlaces('Київ Хрещатик 1'), providers.searchPlaces('Київ Хрещатик 1')]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.get('q'), 'Київ Хрещатик 1');
  assert.equal(calls[0].url.searchParams.get('countrycodes'), 'ua');
  assert.equal(calls[0].url.searchParams.get('limit'), '5');
  assert.equal(calls[0].options.headers['Accept-Language'], 'uk');
  assert.match(calls[0].options.headers['User-Agent'], /MappiBot/);
  assert.equal(first.length, 1);
  first[0].name = 'mutated';
  assert.equal(second[0].name, 'Київ, Україна');
  assert.equal((await providers.searchPlaces('Київ Хрещатик 1'))[0].name, 'Київ, Україна');
  await assert.rejects(providers.searchPlaces('x'), { code: 'INVALID_INPUT' });
});

test('Nominatim requests are globally serialized at least 1100ms apart across provider instances', async () => {
  const times = [];
  const fetchImpl = async () => { times.push(Date.now()); return response([]); };
  await Promise.all([createProviders({ fetchImpl }).searchPlaces('Львів'), createProviders({ fetchImpl }).searchPlaces('Харків')]);
  assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 1_090, `spacing was ${times[1] - times[0]}ms`);
});

test('nearby stops caps radius, sorts nearest, merges coincident platforms and keeps opposite directions', async () => {
  let query;
  const providers = createProviders({ fetchImpl: async (_, init) => {
    query = new URLSearchParams(init.body).get('data');
    return response({ elements: [
      stop(1, 50.00001, { name: 'Площа' }), stop(2, 50.00002, { name: 'Площа' }, 'way'),
      stop(3, 50.00004, { name: 'Площа', local_ref: '2' }), stop(4, 50.0003, { name: 'Площа' }),
      ...Array.from({ length: 12 }, (_, i) => stop(10 + i, 50.001 + i * 0.0002)), stop(100, 51),
    ] });
  } });
  const result = await providers.nearbyStops(50, 30.5, 9_999);
  assert.match(query, /around:1500,50\.000000,30\.500000/);
  assert.match(query, /out body center/);
  assert.equal(result.length, 8);
  assert.deepEqual(result[0].osmIds, ['node/1', 'way/2']);
  assert.ok(result.some(item => item.id === 'node/3'));
  assert.ok(result.some(item => item.id === 'node/4'));
  assert.ok(result.every((item, index) => !index || item.distance >= result[index - 1].distance));
  await assert.rejects(providers.nearbyStops(NaN, 30), { code: 'INVALID_INPUT' });
});

test('routes use node, way and relation membership without querying unrelated nearby roads', async () => {
  let query;
  const providers = createProviders({ fetchImpl: async (_, init) => {
    query = new URLSearchParams(init.body).get('data');
    return response({ elements: [
      { type: 'relation', id: 5, tags: { type: 'route', route: 'bus', ref: '10', name: 'A → B', from: 'A', to: 'B' } },
      { type: 'relation', id: 6, tags: { type: 'route', route: 'tram', ref: '2' } },
      { type: 'relation', id: 7, tags: { type: 'route', route: 'bicycle', ref: '1' } },
    ] });
  } });
  const result = await providers.stopRoutes({ id: 'node/1', osmIds: ['way/2', 'relation/3'] });
  for (const fragment of ['node(1);', 'way(2);', 'relation(3);', 'relation(bn.stops)', 'relation(bw.stops)', 'relation(br.stops)']) assert.ok(query.includes(fragment));
  assert.deepEqual(result.map(item => item.ref), ['2', '10']);
  assert.equal(result[1].url, 'https://www.openstreetmap.org/relation/5');
  await assert.rejects(providers.stopRoutes({ id: 'node/1);out;' }), { code: 'INVALID_INPUT' });
});

test('Overpass cache expires after five minutes and partial/outage responses are errors', async () => {
  let clock = NOW;
  let count = 0;
  const providers = createProviders({ now: () => clock, fetchImpl: async () => {
    count += 1;
    return count === 1 ? response({ elements: [] }) : response({ elements: [], remark: 'runtime error: timed out' });
  } });
  await providers.nearbyStops(50, 30);
  clock += 299_999;
  await providers.nearbyStops(50, 30);
  assert.equal(count, 1);
  clock += 2;
  await assert.rejects(providers.nearbyStops(50, 30), { code: 'INVALID_RESPONSE' });
  assert.equal(count, 2);
  const failed = createProviders({ fetchImpl: async () => new Response('upstream failure', { status: 502 }) });
  await assert.rejects(failed.stopRoutes({ id: 'node/1' }), { code: 'UPSTREAM_UNAVAILABLE' });
});

test('cached live payload is rechecked for vehicle age and filtered using exact route numbers', async () => {
  let clock = NOW;
  let count = 0;
  const providers = createProviders({ now: () => clock, fetchImpl: async () => {
    count += 1;
    return response({ positions: [point({ timestamp: NOW / 1_000 - 175 }), point({ gps_id: 'other', number: '17' })] });
  } });
  const first = await providers.liveDnipro('177');
  assert.equal(first.vehicles.length, 1);
  clock += 6_000;
  const later = await providers.liveDnipro('177');
  assert.equal(later.vehicles.length, 0);
  assert.equal(later.staleCount, 1);
  assert.equal(later.fetchedAt, first.fetchedAt);
  assert.equal(count, 1);
  assert.equal((await providers.liveDnipro('7')).vehicles.length, 0);
});

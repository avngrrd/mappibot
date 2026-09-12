import test from 'node:test';
import assert from 'node:assert/strict';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { createKyivProvider } from '../src/kyiv.mjs';

const TIME = Date.UTC(2026, 8, 12, 10, 0, 0);
const proto = GtfsRealtimeBindings.transit_realtime.FeedMessage;
function vehicle(id = 'bus1', changes = {}) {
  return {
    id,
    vehicle: {
      trip: { routeId: '3_9' },
      vehicle: { id, label: '104', licensePlate: '1744' },
      position: { latitude: 50.44, longitude: 30.63 },
      timestamp: TIME / 1000 - 20,
      ...changes
    }
  };
}
function response(entities, header = {}) {
  const bytes = proto.encode(proto.fromObject({
    header: { gtfsRealtimeVersion: '2.0', incrementality: 0, timestamp: TIME / 1000, ...header },
    entity: entities
  })).finish();
  return new Response(bytes, { headers: { 'Content-Type': 'application/x-protobuf' } });
}

test('uses the documented Kyiv public label, never the numeric suffix of routeId', async () => {
  const live = createKyivProvider({ now: () => TIME, fetchImpl: async () => response([vehicle()]) });
  const result = await live('№104');
  assert.equal(result.vehicles.length, 1);
  assert.equal(result.vehicles[0].route, '104');
  assert.equal(result.vehicles[0].routeIsPublicNumber, true);
  assert.match(result.vehicles[0].name, /Автобус · № 104 · борт 1744/);
  assert.equal((await live('9')).vehicles.length, 0);
  assert.equal((await live('3_9')).vehicles.length, 1);
  assert.equal(result.fetchedAt, new Date(TIME).toISOString());
});

test('missing public label produces an explicit route ID with no invented route number', async () => {
  const live = createKyivProvider({ now: () => TIME, fetchImpl: async () => response([
    vehicle('a', { vehicle: { id: 'a' } })
  ]) });
  const result = await live('3_9');
  assert.equal(result.vehicles[0].route, 'ID 3_9');
  assert.equal(result.vehicles[0].routeIsPublicNumber, false);
  assert.match(result.vehicles[0].name, /маршрут ID 3_9/);
  assert.doesNotMatch(result.vehicles[0].name, /№ 9/);
});

test('rejects fresh spoofed coordinates, missing coordinates and every outside-Kyiv boundary', async () => {
  const locations = [[-12.04, -77.05], [0, 0], [50.19, 30.5], [50.71, 30.5], [50.4, 30.19], [50.4, 30.91], [NaN, 30.5]];
  const entities = locations.map(([latitude, longitude], i) => vehicle(`bad${i}`, { position: { latitude, longitude } }));
  entities.push(vehicle('missing', { position: undefined }), vehicle('good'));
  const live = createKyivProvider({ now: () => TIME, fetchImpl: async () => response(entities) });
  const result = await live();
  assert.deepEqual(result.vehicles.map(v => v.id), ['kyiv:good']);
  assert.match(result.source, /GPS-помилки/);
});

test('checks observation timestamps independently of a fresh feed header and clamps slight future skew', async () => {
  const entities = [
    vehicle('old', { timestamp: TIME / 1000 - 181 }),
    vehicle('missing', { timestamp: undefined }),
    vehicle('future', { timestamp: TIME / 1000 + 61 }),
    vehicle('boundary', { timestamp: TIME / 1000 - 180 }),
    vehicle('skew', { timestamp: TIME / 1000 + 30 })
  ];
  const live = createKyivProvider({ now: () => TIME, fetchImpl: async () => response(entities) });
  const result = await live();
  assert.equal(result.staleCount, 3);
  assert.deepEqual(result.vehicles.map(v => v.id), ['kyiv:boundary', 'kyiv:skew']);
  assert.equal(result.vehicles[1].updatedAt, new Date(TIME).toISOString());
});

test('revalidates vehicle ages during the 20 second cache window and refreshes at its boundary', async () => {
  let clock = TIME;
  let requests = 0;
  const live = createKyivProvider({ now: () => clock, fetchImpl: async () => {
    requests++;
    return response([vehicle('expiring', { timestamp: TIME / 1000 - 175 })]);
  } });
  assert.equal((await live()).vehicles.length, 1);
  clock += 6_000;
  assert.equal((await live()).vehicles.length, 0);
  assert.equal(requests, 1);
  clock = TIME + 20_000;
  await live();
  assert.equal(requests, 2);
});

test('failed refresh does not serve expired cached vehicles, and a later refresh recovers', async () => {
  let clock = TIME;
  let fail = false;
  const live = createKyivProvider({ now: () => clock, fetchImpl: async () => {
    if (fail) throw new Error('network unavailable');
    return response([vehicle()]);
  } });
  assert.equal((await live()).vehicles.length, 1);
  clock += 200_000;
  fail = true;
  await assert.rejects(live(), /network unavailable/);
  fail = false;
  const result = await live();
  assert.equal(result.vehicles.length, 0);
  assert.equal(result.staleCount, 1);
});

test('coalesces simultaneous callers and returns independent arrays and vehicle objects', async () => {
  let resolve;
  let requests = 0;
  const live = createKyivProvider({ now: () => TIME, fetchImpl: () => {
    requests++;
    return new Promise(done => { resolve = done; });
  } });
  const first = live();
  const second = live('104');
  resolve(response([vehicle()]));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(requests, 1);
  a.vehicles[0].lat = -12;
  a.vehicles.length = 0;
  assert.ok(b.vehicles[0].lat > 50);
  assert.equal((await live()).vehicles.length, 1);
});

test('rejects invalid protobuf, unsuccessful HTTP and differential snapshots', async () => {
  const options = [
    async () => new Response('not a protobuf feed'),
    async () => new Response('', { status: 503 }),
    async () => response([vehicle()], { incrementality: 1 })
  ];
  for (const fetchImpl of options) await assert.rejects(createKyivProvider({ now: () => TIME, fetchImpl })());
});

test('deletions never appear and duplicate IDs retain the newest valid observation', async () => {
  const deleted = { ...vehicle('deleted'), isDeleted: true };
  const live = createKyivProvider({ now: () => TIME, fetchImpl: async () => response([
    deleted, vehicle('duplicate'), vehicle('duplicate', { timestamp: TIME / 1000 - 100 })
  ]) });
  const result = await live();
  assert.equal(result.vehicles.length, 1);
  assert.equal(result.vehicles[0].updatedAt, new Date(TIME - 20_000).toISOString());
});

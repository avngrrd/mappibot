import test from 'node:test';
import assert from 'node:assert/strict';
import { createWalking, readJsonBounded } from '../src/walking.mjs';

const from = { lat: 50.45, lon: 30.52 };
const to = { lat: 50.451, lon: 30.521 };
const response = value => new Response(JSON.stringify(value));
const good = () => ({ code: 'Ok', waypoints: [{ location: [from.lon, from.lat] }, { location: [to.lon, to.lat] }],
  routes: [{ distance: 180.4, duration: 130.2, geometry: { type: 'LineString', coordinates: [[from.lon, from.lat], [30.5208, 50.4502], [to.lon, to.lat]] } }] });

test('foot routing uses FOSSGIS foot profile, real geometry/duration and a bounded immutable cache', async () => {
  let calls = 0;
  const foot = createWalking({ fetchImpl: async (url, options) => {
    calls++;
    assert.match(url, /routed-foot\/route\/v1\/foot\/30\.520000,50\.450000;30\.521000,50\.451000/);
    assert.equal(new URL(url).searchParams.get('geometries'), 'geojson');
    assert.ok(options.signal);
    assert.match(options.headers['User-Agent'], /MappiBot/);
    return response(good());
  } });
  const result = await foot.route(from, to);
  assert.equal(result.verified, true);
  assert.equal(result.meters, 180);
  assert.equal(result.seconds, 130);
  assert.deepEqual(result.lines[0][0], [50.45, 30.52]);
  result.lines[0][0][0] = 0;
  assert.equal((await foot.route(from, to)).lines[0][0][0], 50.45);
  assert.equal(calls, 1);
});

test('NoRoute, outages, excessive snapping and invalid geometry never become straight walking paths', async () => {
  const invalid = good(); invalid.routes[0].geometry.coordinates[1] = [0, 0];
  const far = good(); far.waypoints[0].location = [30.53, 50.45];
  for (const [data, reason] of [[{ code: 'NoRoute' }, 'no_route'], [invalid, 'invalid_response'], [far, 'snap_too_far']]) {
    const foot = createWalking({ fetchImpl: async () => response(data) });
    const result = await foot.route(from, to);
    assert.equal(result.verified, false);
    assert.equal(result.reason, reason);
    assert.equal(result.lines, undefined);
    assert.equal(result.seconds, undefined);
  }
  const outage = createWalking({ fetchImpl: async () => { throw new Error('secret-upstream-url'); } });
  const result = await outage.route(from, to);
  assert.equal(result.reason, 'unavailable');
  assert.ok(!JSON.stringify(result).includes('secret-upstream-url'));
});

test('foot rate limit is shared across instances and unchanged coordinates need no HTTP', async () => {
  const calls = [];
  const fetchImpl = async () => { calls.push(Date.now()); return response(good()); };
  const a = createWalking({ fetchImpl }), b = createWalking({ fetchImpl });
  await Promise.all([a.route(from, to), b.route(from, to)]);
  assert.ok(calls[1] - calls[0] >= 1_090);
  assert.deepEqual((await a.route(from, from)).lines, []);
  assert.equal(calls.length, 2);
});

test('bounded reads reject excessive bodies even without Content-Length', async () => {
  await assert.rejects(readJsonBounded(new Response('x'.repeat(1_001)), 1_000));
});

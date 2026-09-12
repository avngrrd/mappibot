import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanner, findTopologyJourneys, normalizePlannerTopology } from '../src/planner.mjs';

const FROM = { lat: 50.4, lon: 30.4 };
const TO = { lat: 50.45, lon: 30.4 };
const stop = (id, lat, extra = {}) => ({ id, name: id, lat, lon: 30.4, board: true, alight: true, ...extra });
const route = (id, stops, extra = {}) => ({ id, ref: id, mode: 'bus', name: id, stops, source: 'test', ...extra });
const count = elements => ({ elements: [...elements, { type: 'count', tags: { total: String(elements.length) } }] });
function topologyPayload() {
  return count([
    { type: 'relation', id: 1, tags: { type: 'route', route: 'bus', ref: '62', 'public_transport:version': '2' }, members: [
      { type: 'node', ref: 10, role: 'stop_entry_only' }, { type: 'node', ref: 11, role: 'platform_entry_only' }, { type: 'node', ref: 12, role: 'stop_exit_only' },
    ] },
    { type: 'node', id: 10, lat: FROM.lat, lon: FROM.lon, tags: { name: 'Початок', public_transport: 'stop_position' } },
    { type: 'node', id: 11, lat: FROM.lat, lon: FROM.lon, tags: { name: 'Початок', public_transport: 'platform' } },
    { type: 'node', id: 12, lat: TO.lat, lon: TO.lon, tags: { name: 'Кінець', public_transport: 'stop_position' } },
  ]);
}

test('planner topology preserves direction and entry/exit-only restrictions while merging a stop/platform pair', () => {
  const topology = normalizePlannerTopology(topologyPayload());
  assert.equal(topology.routes.length, 1);
  assert.equal(topology.routes[0].stops.length, 2);
  assert.equal(topology.routes[0].stops[0].id, 'node/11');
  assert.equal(topology.routes[0].stops[0].board, true);
  assert.equal(topology.routes[0].stops[0].alight, false);
  assert.equal(topology.routes[0].stops[1].board, false);
  assert.equal(findTopologyJourneys(topology.routes, [], { from: FROM, to: TO }).length, 1);
  assert.equal(findTopologyJourneys(topology.routes, [], { from: TO, to: FROM }).length, 0);
  const missingVersion = topologyPayload(); delete missingVersion.elements[0].tags['public_transport:version'];
  assert.equal(normalizePlannerTopology(missingVersion).routes.length, 0);
  const partial = topologyPayload(); partial.remark = 'runtime error';
  assert.throws(() => normalizePlannerTopology(partial), { code: 'UPSTREAM_UNAVAILABLE' });
});

test('one-transfer search requires exact shared stop IDs or explicit official transfer pairs', () => {
  const first = route('one', [stop('a', 50.4), stop('x', 50.425)]);
  const second = route('two', [stop('x', 50.425), stop('b', 50.45)]);
  assert.equal(findTopologyJourneys([first, second], [], { from: FROM, to: TO, maxTransfers: 0 }).length, 0);
  const shared = findTopologyJourneys([first, second], [], { from: FROM, to: TO, maxTransfers: 1 });
  assert.equal(shared[0].transfers, 1);
  assert.equal(shared[0].walks.find(walk => walk.kind === 'transfer').meters, 0);
  const nearby = route('nearby', [stop('y', 50.42501), stop('b', 50.45)]);
  assert.equal(findTopologyJourneys([first, nearby], [], { from: FROM, to: TO }).length, 0);
  const connected = findTopologyJourneys([first, nearby], [['x', 'y']], { from: FROM, to: TO });
  assert.equal(connected[0].walks.find(walk => walk.kind === 'transfer').meters, null);
  assert.equal(connected[0].walks.find(walk => walk.kind === 'transfer').verified, false);
});

test('topology preserves loop occurrences and does not allow boarding at an exit-only stop', () => {
  const looping = route('loop', [stop('a', 50.4), stop('b', 50.45), stop('a', 50.4)]);
  assert.equal(findTopologyJourneys([looping], [], { from: TO, to: FROM })[0].legs[0].boardIndex, 1);
  const exitOnly = route('exit', [stop('a', 50.4, { board: false }), stop('b', 50.45)]);
  assert.equal(findTopologyJourneys([exitOnly], [], { from: FROM, to: TO }).length, 0);
});

test('planner limits selected alternatives and walking checks to six, preserves official geometry and returns no transit ETA', async () => {
  const routes = [1, 2, 3, 4].map(id => route(`metro:${id}`, [stop(`a${id}`, 50.4), stop(`b${id}`, 50.45)], { mode: 'subway', segments: [[[[50.4, 30.4], [50.45, 30.4]]]] }));
  const calls = [];
  const planner = createPlanner({
    metroGraph: { async load() { return { routes, transferPairs: [], stationCount: 8 }; } },
    walking: { async route(from, to) { calls.push([from, to]); return { meters: 10, verified: true, lines: [[[from.lat, from.lon], [to.lat, to.lon]]], seconds: 8 }; } },
    fetchImpl: async () => { throw new Error('No Overpass should be needed for official-metro-only request'); },
  });
  const result = await planner.plan({ from: FROM, to: TO, modes: ['subway'], maxTransfers: 0, sort: 'transfers' });
  assert.equal(result.itineraries.length, 3);
  assert.ok(calls.length <= 6);
  assert.deepEqual(result.itineraries[0].legs[0].lines, [[[50.4, 30.4], [50.45, 30.4]]]);
  assert.equal(result.itineraries[0].distanceKind, 'routed');
  assert.equal(result.itineraries[0].walkingVerified, true);
  assert.ok(result.itineraries[0].walks.every(walk => walk.seconds === 8));
  assert.equal(result.itineraries[0].legs[0].seconds, undefined);
  assert.equal(result.itineraries[0].arrivalTime, undefined);
  assert.equal(result.itineraries[0].fare, undefined);
});

test('surface plan makes one bounded endpoint topology query and caches it; walking outages remain explicit', async () => {
  let calls = 0;
  const selected = [];
  const planner = createPlanner({ fetchImpl: async (_, options) => {
    calls++;
    const query = new URLSearchParams(options.body).get('data');
    assert.match(query, /around:800/);
    assert.match(query, /out body center/);
    assert.ok(!query.includes('out geom'));
    return new Response(JSON.stringify(topologyPayload()));
  }, walking: { async route() { throw new Error('unavailable'); } },
  mapData: { rememberCandidateRoutes(routes) { selected.push(routes); } } });
  const result = await planner.plan({ from: FROM, to: TO, modes: ['bus'] });
  assert.equal(result.itineraries[0].distanceKind, 'straight_line');
  assert.equal(result.itineraries[0].walkingVerified, false);
  assert.ok(result.itineraries[0].walks.every(walk => walk.lines === undefined));
  await planner.plan({ from: FROM, to: TO, modes: ['bus'] });
  assert.equal(calls, 1);
  assert.equal(selected.length, 2);
  assert.deepEqual(selected[0].map(route => route.id), ['relation/1']);
  assert.equal(selected[0][0].stops.length, 2);
});

test('verified foot detours can reverse straight-line ranking; a farther reachable stop is not pruned prematurely', async () => {
  const routes = [
    route('near', [stop('near-a', 50.4001), stop('near-b', 50.4499)], { mode: 'subway' }),
    route('reachable', [stop('reachable-a', 50.401), stop('reachable-b', 50.449)], { mode: 'subway' }),
  ];
  const planner = createPlanner({ metroGraph: { async load() { return { routes, transferPairs: [], stationCount: 4 }; } },
    walking: { async route(from, to) { return { verified: true, meters: (from.id || to.id).startsWith('near') ? 1_000 : 200, lines: [] }; } } });
  const result = await planner.plan({ from: FROM, to: TO, modes: ['subway'], sort: 'walk' });
  assert.equal(result.itineraries[0].legs[0].routeId, 'reachable');
  assert.equal(result.itineraries[0].accessEgressMeters, 400);
  assert.equal(result.coverage.walkingLegsChecked, 4);
});

test('unwalkable routes are excluded, invalid inputs do no networking and metro survives an OSM outage', async () => {
  const network = { routes: [route('metro', [stop('a', 50.4), stop('b', 50.45)], { mode: 'subway' })], transferPairs: [], stationCount: 2 };
  let calls = 0;
  const planner = createPlanner({ metroGraph: { async load() { return network; } }, fetchImpl: async () => { calls++; throw new Error('private upstream'); },
    walking: { async route() { return { meters: 0, verified: false, reason: 'no_route' }; } } });
  for (const input of [{ from: { lat: 0, lon: 0 }, to: TO }, { from: FROM, to: TO, modes: ['car'] }, { from: FROM, to: TO, maxTransfers: 2 }, { from: FROM, to: FROM }]) {
    await assert.rejects(planner.plan(input), { code: 'INVALID_INPUT' });
  }
  assert.equal(calls, 0);
  const result = await planner.plan({ from: FROM, to: TO, modes: ['bus', 'subway'] });
  assert.deepEqual(result.itineraries, []);
  assert.equal(result.coverage.rejectedWalking, 1);
  assert.ok(result.notices.some(notice => notice.includes('Наземні маршрути зараз недоступні')));
  assert.ok(!JSON.stringify(result).includes('private upstream'));
});

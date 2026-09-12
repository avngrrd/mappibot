import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetroGraph, normalizeMetroGraph } from '../src/metro-graph.mjs';

function fixture() {
  const stations = [
    ['a', 'Початок', 'Лінія A', 50.4, null], ['x', 'Пересадка A', 'Лінія A', 50.42, 'y'],
    ['y', 'Пересадка B', 'Лінія B', 50.421, 'x'], ['b', 'Кінець', 'Лінія B', 50.45, null],
  ];
  const stationData = { features: stations.map(([code1, name, line, lat, transf_st]) => ({ attributes: { code1, name, line, transf_st }, geometry: { x: 30.4, y: lat } })) };
  const edges = [['a', 'x', 'Лінія A', 'Прямий'], ['x', 'a', 'Лінія A', 'Зворотній'], ['y', 'b', 'Лінія B', 'Прямий'], ['b', 'y', 'Лінія B', 'Зворотній']];
  const edgeData = { features: edges.map(([from, to, line, direction]) => ({
    attributes: { from_code1: from, to_code1: to, num_route: line, napryamok: direction, order_: 1 },
    geometry: { paths: [[stationData.features.find(station => station.attributes.code1 === from), stationData.features.find(station => station.attributes.code1 === to)].map(station => [station.geometry.x, station.geometry.y])] },
  })) };
  return { stationData, edgeData };
}

test('official metro uses directed edges and reciprocal transfer codes without inventing travel time', () => {
  const { stationData, edgeData } = fixture();
  const graph = normalizeMetroGraph(stationData, edgeData, 1_000);
  assert.equal(graph.stationCount, 4);
  assert.equal(graph.edgeCount, 4);
  assert.deepEqual(graph.transferPairs, [['metro:x', 'metro:y']]);
  assert.deepEqual(graph.routes[0].stops.map(stop => stop.id), ['metro:a', 'metro:x']);
  assert.deepEqual(graph.routes[1].stops.map(stop => stop.id), ['metro:x', 'metro:a']);
  assert.deepEqual(graph.routes[0].segments[0][0][0], [50.4, 30.4]);
  assert.ok(!JSON.stringify(graph).includes('duration'));
});

test('metro refuses truncated, disconnected, unmatched and malformed graph data', () => {
  for (const kind of ['truncated', 'unmatched', 'transfer', 'coordinates', 'order']) {
    const { stationData, edgeData } = fixture();
    if (kind === 'truncated') edgeData.exceededTransferLimit = true;
    if (kind === 'unmatched') edgeData.features[0].attributes.to_code1 = 'missing';
    if (kind === 'transfer') stationData.features[1].attributes.transf_st = 'a';
    if (kind === 'coordinates') edgeData.features[0].geometry.paths[0][0] = [0, 0];
    if (kind === 'order') edgeData.features[0].attributes.order_ = 3;
    assert.throws(() => normalizeMetroGraph(stationData, edgeData), { code: 'UPSTREAM_UNAVAILABLE' });
  }
});

test('metro caches both official layers and never accepts ArcGIS transfer-limit truncation', async () => {
  const { stationData, edgeData } = fixture();
  let calls = 0;
  const metro = createMetroGraph({ fetchImpl: async url => {
    calls++;
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('outSR'), '4326');
    return new Response(JSON.stringify(parsed.pathname.includes('/4/') ? stationData : edgeData));
  } });
  const graph = await metro.load();
  graph.routes[0].stops[0].name = 'changed';
  assert.equal((await metro.load()).routes[0].stops[0].name, 'Початок');
  assert.equal(calls, 2);
});

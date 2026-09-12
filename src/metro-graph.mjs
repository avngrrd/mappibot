import { readJsonBounded } from './walking.mjs';
import { validCoordinates } from './providers.mjs';

const BASE = 'https://gisserver-stage.kyivcity.gov.ua/mayno/rest/services/KYIV_API/transport_public/MapServer';
const SOURCE = 'https://data.kyivcity.gov.ua/dataset/rozklad-rukhu-miskoho-elektrychnoho-ta-avtomobilnoho-transportu-dep-transport';
const text = value => typeof value === 'string' ? value.trim().slice(0, 250) : '';
const fail = () => Object.assign(new Error('Офіційна схема метро зараз недоступна або неповна.'), { code: 'UPSTREAM_UNAVAILABLE' });
const kyiv = (lat, lon) => validCoordinates(lat, lon) && lat >= 50.2 && lat <= 50.7 && lon >= 30.2 && lon <= 30.9;

export function normalizeMetroGraph(stationData, edgeData, nowMs = Date.now()) {
  const valid = (data, maximum) => data && !data.error && !data.exceededTransferLimit
    && Array.isArray(data.features) && data.features.length > 0 && data.features.length <= maximum;
  if (!valid(stationData, 128) || !valid(edgeData, 512)) throw fail();
  const stations = new Map();
  for (const item of stationData.features) {
    const attrs = item.attributes || {};
    const code = text(attrs.code1);
    const name = text(attrs.name);
    const line = text(attrs.line);
    const lat = item.geometry?.y, lon = item.geometry?.x;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code) || !name || !line || !kyiv(lat, lon) || stations.has(code)) throw fail();
    stations.set(code, { id: `metro:${code}`, code, name, line, lat, lon, transferTo: text(attrs.transf_st) || null });
  }
  const groups = new Map();
  let pointCount = 0;
  for (const item of edgeData.features) {
    const attrs = item.attributes || {};
    const from = stations.get(text(attrs.from_code1));
    const to = stations.get(text(attrs.to_code1));
    const line = text(attrs.num_route);
    const direction = text(attrs.napryamok);
    const order = attrs.order_;
    const paths = item.geometry?.paths;
    if (!from || !to || from.code === to.code || from.line !== line || to.line !== line
      || !['Прямий', 'Зворотній'].includes(direction) || !Number.isSafeInteger(order) || order < 1
      || !Array.isArray(paths) || !paths.length || paths.length > 20) throw fail();
    const lines = paths.map(points => {
      if (!Array.isArray(points) || points.length < 2) throw fail();
      return points.map(point => {
        if (!Array.isArray(point) || !kyiv(point[1], point[0]) || ++pointCount > 30_000) throw fail();
        return [point[1], point[0]];
      });
    });
    const key = `${line}|${direction}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ from: from.code, to: to.code, order, lines });
  }
  const routes = [];
  for (const [key, edges] of groups) {
    edges.sort((a, b) => a.order - b.order);
    if (edges[0].order !== 1 || edges.some((edge, index) => index && (edge.order !== edges[index - 1].order + 1 || edge.from !== edges[index - 1].to))) throw fail();
    const [line, direction] = key.split('|');
    routes.push({ id: `metro-line:${line}:${direction}`, ref: 'Метро', mode: 'subway', name: line, direction,
      stops: [stations.get(edges[0].from), ...edges.map(edge => stations.get(edge.to))].map(stop => ({ ...stop, board: true, alight: true })),
      segments: edges.map(edge => edge.lines), source: SOURCE });
  }
  const transferPairs = [];
  for (const station of stations.values()) if (station.transferTo) {
    const other = stations.get(station.transferTo);
    if (!other || other.transferTo !== station.code || other.line === station.line) throw fail();
    if (station.code < other.code) transferPairs.push([station.id, other.id]);
  }
  return { routes, transferPairs, stationCount: stations.size, edgeCount: edgeData.features.length, fetchedAt: new Date(nowMs).toISOString(), source: SOURCE };
}

export function createMetroGraph({ fetchImpl = fetch, now = Date.now, baseUrl = BASE,
  userAgent = 'MappiBot/0.1 (https://github.com/avngrrd/mappibot)' } = {}) {
  let cached, inflight;
  async function layer(id) {
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/${id}/query`);
    for (const [name, value] of Object.entries({ where: '1=1', outFields: '*', returnGeometry: 'true', outSR: '4326', resultRecordCount: '2000', f: 'json' })) url.searchParams.set(name, value);
    const response = await fetchImpl(url.toString(), { headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(12_000), redirect: 'error' });
    if (!response.ok) throw fail();
    return readJsonBounded(response, 2_000_000);
  }
  return {
    async load() {
      if (cached && cached.expires > now()) return structuredClone(cached.value);
      if (!inflight) inflight = Promise.all([layer(4), layer(5)])
        .then(([stations, edges]) => normalizeMetroGraph(stations, edges, now()))
        .then(value => { cached = { value, expires: now() + 3_600_000 }; return value; })
        .catch(() => { throw fail(); }).finally(() => { inflight = undefined; });
      return structuredClone(await inflight);
    },
  };
}

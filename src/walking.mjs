import { setTimeout as delay } from 'node:timers/promises';
import { distanceMeters, validCoordinates } from './providers.mjs';

const SOURCE = 'https://routing.openstreetmap.de/about.html';
const DEFAULT_URL = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';
// FOSSGIS policy: max one request/second, no heavy use. Shared across instances.
let tail = Promise.resolve();
let nextStart = 0;
let pending = 0;

export async function readJsonBounded(response, maximum) {
  if (Number(response.headers?.get('content-length')) > maximum) throw new Error('Upstream response too large');
  const reader = response.body?.getReader?.();
  if (!reader) {
    const data = await response.json();
    if (Buffer.byteLength(JSON.stringify(data)) > maximum) throw new Error('Upstream response too large');
    return data;
  }
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error('Upstream response too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function scheduled(task, deadline) {
  if (pending >= 12) return Promise.resolve({ verified: false, reason: 'busy' });
  pending += 1;
  const result = tail.then(async () => {
    const wait = Math.max(0, nextStart - Date.now());
    if (Date.now() + wait + 800 >= deadline) return { verified: false, reason: 'timeout' };
    if (wait) await delay(wait);
    nextStart = Date.now() + 1_100;
    return task();
  });
  tail = result.catch(() => {}).finally(() => { pending -= 1; });
  return result;
}

export function createWalking({ fetchImpl = fetch, now = Date.now, url = DEFAULT_URL,
  userAgent = 'MappiBot/0.1 (https://github.com/avngrrd/mappibot)' } = {}) {
  const cache = new Map();
  const inflight = new Map();
  const pointKey = point => `${point.lat.toFixed(6)},${point.lon.toFixed(6)}`;
  return {
    async route(from, to, { deadline = Date.now() + 10_000 } = {}) {
      if (!validCoordinates(from?.lat, from?.lon) || !validCoordinates(to?.lat, to?.lon)) {
        throw Object.assign(new Error('Некоректні координати пішого переходу.'), { code: 'INVALID_INPUT' });
      }
      const straight = distanceMeters(from.lat, from.lon, to.lat, to.lon);
      // Identical coordinates need no request or fabricated line geometry.
      if (straight < 0.5) return { meters: 0, seconds: 0, verified: true, lines: [], source: SOURCE };
      const key = `${pointKey(from)}>${pointKey(to)}`;
      const cached = cache.get(key);
      if (cached && cached.expires > now()) return structuredClone(cached.value);
      cache.delete(key);
      if (inflight.has(key)) return structuredClone(await inflight.get(key));
      const task = scheduled(async () => {
        const unknown = reason => ({ meters: Math.round(straight), verified: false, reason, source: SOURCE });
        try {
          const coordinates = `${from.lon.toFixed(6)},${from.lat.toFixed(6)};${to.lon.toFixed(6)},${to.lat.toFixed(6)}`;
          const endpoint = new URL(url.replace(/\/?$/, '/') + coordinates);
          for (const [name, value] of Object.entries({ geometries: 'geojson', overview: 'full', steps: 'false', alternatives: 'false', generate_hints: 'false', radiuses: '100;100' })) endpoint.searchParams.set(name, value);
          const timeout = Math.min(3_500, deadline - Date.now());
          if (timeout < 500) return unknown('timeout');
          const response = await fetchImpl(endpoint.toString(), { headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(timeout), redirect: 'error' });
          if (response.status === 429) {
            const retry = Number(response.headers?.get('retry-after'));
            nextStart = Math.max(nextStart, Date.now() + (Number.isFinite(retry) && retry > 0 ? Math.min(retry, 300) * 1_000 : 30_000));
            return unknown('unavailable');
          }
          const data = await readJsonBounded(response, 600_000);
          if (['NoRoute', 'NoSegment'].includes(data?.code)) return unknown('no_route');
          if (!response.ok || data?.code !== 'Ok') return unknown('unavailable');
          const route = data.routes?.[0];
          const points = route?.geometry?.coordinates;
          if (route?.geometry?.type !== 'LineString' || !Array.isArray(points) || points.length < 2 || points.length > 8_000
            || !Number.isFinite(route.distance) || route.distance < 0 || route.distance > 20_000
            || !Number.isFinite(route.duration) || route.duration < 0 || route.duration > 36_000
            || !Array.isArray(data.waypoints) || data.waypoints.length !== 2) return unknown('invalid_response');
          const inside = ([lon, lat]) => validCoordinates(lat, lon) && lat >= 44.1 && lat <= 52.4 && lon >= 22 && lon <= 40.3;
          if (points.some(point => !Array.isArray(point) || !inside(point))) return unknown('invalid_response');
          const snaps = data.waypoints.map((point, index) => {
            if (!Array.isArray(point?.location) || !inside(point.location)) return Infinity;
            const original = index === 0 ? from : to;
            return distanceMeters(original.lat, original.lon, point.location[1], point.location[0]);
          });
          if (snaps.some(meters => meters > 100)) return unknown('snap_too_far');
          if (route.distance + snaps[0] + snaps[1] + 10 < straight) return unknown('invalid_response');
          if (distanceMeters(points[0][1], points[0][0], data.waypoints[0].location[1], data.waypoints[0].location[0]) > 10
            || distanceMeters(points.at(-1)[1], points.at(-1)[0], data.waypoints[1].location[1], data.waypoints[1].location[0]) > 10) return unknown('invalid_response');
          return { meters: Math.round(route.distance), seconds: Math.round(route.duration), verified: true,
            lines: [points.map(([lon, lat]) => [lat, lon])], snapMeters: snaps.map(Math.round), source: SOURCE };
        } catch { return unknown('unavailable'); }
      }, deadline).then(value => {
        const normalized = { meters: Math.round(straight), source: SOURCE, ...value };
        cache.set(key, { value: normalized, expires: now() + (normalized.verified ? 1_800_000 : 15_000) });
        while (cache.size > 256) cache.delete(cache.keys().next().value);
        return normalized;
      }).finally(() => inflight.delete(key));
      inflight.set(key, task);
      return structuredClone(await task);
    },
  };
}

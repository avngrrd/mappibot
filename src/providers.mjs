import { setTimeout as sleep } from 'node:timers/promises';

const DNIPRO_SOURCE = 'https://data.gov.ua/dataset/real-transport-dnipro';
const MODES = /^(bus|trolleybus|tram|subway|light_rail|train|ferry|monorail|share_taxi)$/;
const OSM_ID = /^(node|way|relation)\/([1-9]\d{0,15})$/;
const TTL = 300_000;

function providerError(message, code = 'UPSTREAM_UNAVAILABLE') {
  return Object.assign(new Error(message), { code });
}

// These queues are shared by every provider instance in this Node process.
// Run one bot replica: a public provider's limits apply across the whole app.
class Queue {
  constructor(gap, capacity) {
    this.gap = gap;
    this.capacity = capacity;
    this.pending = 0;
    this.nextStart = 0;
    this.tail = Promise.resolve();
  }

  run(task) {
    if (this.pending >= this.capacity) {
      return Promise.reject(providerError('Забагато запитів до джерела. Спробуйте трохи пізніше.', 'BUSY'));
    }
    this.pending += 1;
    const result = this.tail.then(async () => {
      const delay = this.nextStart - Date.now();
      if (delay > 0) await sleep(delay);
      this.nextStart = Date.now() + this.gap;
      return task();
    });
    this.tail = result.catch(() => {}).finally(() => { this.pending -= 1; });
    return result;
  }

  cooldown(retryAfter) {
    const seconds = Number(retryAfter);
    const delay = retryAfter && Number.isFinite(seconds)
      ? seconds * 1_000
      : Date.parse(retryAfter) - Date.now();
    this.nextStart = Math.max(this.nextStart, Date.now() + Math.max(1_100, Math.min(delay || 30_000, 120_000)));
  }
}

const nominatimQueue = new Queue(1_100, 12);
const overpassQueue = new Queue(1_100, 10);
const dniproQueue = new Queue(1_100, 8);

class Cache {
  constructor(now, maximum = 256) {
    this.now = now;
    this.maximum = maximum;
    this.values = new Map();
    this.inflight = new Map();
  }

  async remember(key, ttl, load) {
    const entry = this.values.get(key);
    if (entry && entry.expires > this.now()) {
      this.values.delete(key);
      this.values.set(key, entry);
      return structuredClone(entry.value);
    }
    this.values.delete(key);
    if (this.inflight.has(key)) return structuredClone(await this.inflight.get(key));
    if (this.inflight.size >= 32) throw providerError('Забагато одночасних пошуків. Спробуйте пізніше.', 'BUSY');
    const request = Promise.resolve().then(load).then(value => {
      this.values.set(key, { expires: this.now() + ttl, value: structuredClone(value) });
      while (this.values.size > this.maximum) this.values.delete(this.values.keys().next().value);
      return value;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return structuredClone(await request);
  }
}

export function validCoordinates(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function number(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return NaN;
  return Number(value);
}

export function distanceMeters(lat1, lon1, lat2, lon2) {
  if (!validCoordinates(lat1, lon1) || !validCoordinates(lat2, lon2)) return NaN;
  const radians = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * radians / 2) ** 2
    + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin((lon2 - lon1) * radians / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

const label = value => typeof value === 'string' ? value.trim().slice(0, 250) : '';
const routeNumber = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, 40) : '';

function stopMode(tags) {
  if (tags.tram === 'yes' || tags.railway === 'tram_stop') return 'tram';
  if (tags.subway === 'yes' || tags.station === 'subway') return 'subway';
  if (tags.trolleybus === 'yes') return 'trolleybus';
  if (tags.bus === 'yes' || tags.highway === 'bus_stop' || tags.amenity === 'bus_station') return 'bus';
  if (tags.train === 'yes' || /^(station|halt)$/.test(tags.railway || '')) return 'train';
  return 'public_transport';
}

function normalizeStops(data, lat, lon, radius) {
  if (!Array.isArray(data?.elements) || data.remark) {
    throw providerError('Джерело зупинок повернуло неповні дані. Спробуйте пізніше.', 'INVALID_RESPONSE');
  }
  const found = [];
  const ids = new Set();
  for (const item of data.elements) {
    if (!item || !OSM_ID.test(`${item.type}/${item.id}`)) continue;
    const id = `${item.type}/${item.id}`;
    if (ids.has(id)) continue;
    ids.add(id);
    const latitude = number(item.lat ?? item.center?.lat);
    const longitude = number(item.lon ?? item.center?.lon);
    if (!validCoordinates(latitude, longitude)) continue;
    const distance = distanceMeters(lat, lon, latitude, longitude);
    if (distance > radius) continue;
    const tags = item.tags ?? {};
    found.push({
      id, name: label(tags['name:uk']) || label(tags.name) || 'Зупинка без назви',
      lat: latitude, lon: longitude, distance: Math.round(distance), mode: stopMode(tags),
      platformRef: label(tags.local_ref) || label(tags.ref), level: label(tags.level),
    });
  }
  found.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  const stops = [];
  for (const stop of found) {
    // Merge only nearly coincident, named platforms with identical references.
    // Retain both OSM IDs so a route attached to either element remains findable.
    const duplicate = stops.find(other => other.name !== 'Зупинка без назви'
      && other.name.toLocaleLowerCase('uk') === stop.name.toLocaleLowerCase('uk')
      && other.mode === stop.mode && other.platformRef === stop.platformRef && other.level === stop.level
      && distanceMeters(other.lat, other.lon, stop.lat, stop.lon) <= 8);
    if (duplicate) (duplicate.osmIds ??= [duplicate.id]).push(stop.id);
    else stops.push(stop);
  }
  return stops.slice(0, 8).map(({ platformRef, level, ...stop }) => stop);
}

function normalizeRoutes(data) {
  if (!Array.isArray(data?.elements) || data.remark) {
    throw providerError('Джерело маршрутів повернуло неповні дані. Спробуйте пізніше.', 'INVALID_RESPONSE');
  }
  const result = new Map();
  for (const item of data.elements) {
    const tags = item?.tags ?? {};
    if (item?.type !== 'relation' || !OSM_ID.test(`relation/${item.id}`)
      || tags.type !== 'route' || !MODES.test(tags.route || '')) continue;
    const id = `relation/${item.id}`;
    result.set(id, {
      id, ref: label(tags.ref), name: label(tags['name:uk']) || label(tags.name),
      from: label(tags['from:uk']) || label(tags.from), to: label(tags['to:uk']) || label(tags.to),
      mode: tags.route, url: `https://www.openstreetmap.org/${id}`,
    });
  }
  return [...result.values()].sort((a, b) => a.ref.localeCompare(b.ref, 'uk', { numeric: true }) || a.id.localeCompare(b.id));
}

/** The official Dnipro v2 JSON fields were checked against the live feed.
 * Each positions[].timestamp is Unix seconds. The feed header is NOT evidence
 * that an individual vehicle is fresh. No ETA is inferred from these points.
 */
export function normalizeDnipro(data, nowMs = Date.now(), source = DNIPRO_SOURCE) {
  if (!Array.isArray(data?.positions) || !Number.isFinite(nowMs)) {
    throw providerError('GPS-джерело Дніпра повернуло невідомий формат.', 'INVALID_RESPONSE');
  }
  let staleCount = 0;
  const vehicles = new Map();
  const modes = { bus: 'Автобус', tram: 'Трамвай', trol: 'Тролейбус' };
  for (const point of data.positions) {
    if (!point || !Object.hasOwn(modes, point.type)) continue;
    const lat = number(point.lat);
    const lon = number(point.lon);
    // Dnipro metropolitan area; rejects zero GPS fixes and points in other cities.
    if (!validCoordinates(lat, lon) || lat < 48.2 || lat > 48.7 || lon < 34.7 || lon > 35.4) continue;
    const timestamp = number(point.timestamp) * 1_000;
    if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > nowMs + 60_000) continue;
    if (nowMs - timestamp > 180_000) { staleCount += 1; continue; }
    const gpsId = routeNumber(point.gps_id);
    const route = routeNumber(point.number);
    if (!gpsId || !route) continue;
    const id = `${point.type}:${route}:${gpsId}`;
    const bort = label(point.bort_number);
    const vehicle = {
      id, route, name: `${modes[point.type]} ${route}${bort ? ` · ${bort}` : ''}`,
      lat, lon, updatedAt: new Date(Math.min(timestamp, nowMs)).toISOString(),
    };
    const previous = vehicles.get(id);
    if (!previous || previous.updatedAt < vehicle.updatedAt) vehicles.set(id, vehicle);
  }
  return { vehicles: [...vehicles.values()], fetchedAt: new Date(nowMs).toISOString(), staleCount, source };
}

export function createProviders({
  fetchImpl = fetch,
  userAgent = 'MappiBot/0.1 (personal Ukraine public-transport Telegram bot)',
  now = Date.now,
  overpassUrl = 'https://overpass-api.de/api/interpreter',
  nominatimUrl = 'https://nominatim.openstreetmap.org/search',
  dniproUrl = 'https://api-t900.icity.com.ua/api/gps_data/',
} = {}) {
  const cache = new Cache(now);

  async function json(url, init, queue, sourceName) {
    return queue.run(async () => {
      try {
        const response = await fetchImpl(url, {
          ...init,
          headers: { 'User-Agent': userAgent, Accept: 'application/json', 'Accept-Language': 'uk', ...init?.headers },
          signal: AbortSignal.timeout(22_000),
        });
        if (!response.ok) {
          if (response.status === 429 || response.status === 503) queue.cooldown(response.headers?.get('retry-after'));
          throw providerError(`${sourceName} тимчасово недоступне (HTTP ${response.status}). Спробуйте пізніше.`);
        }
        if (number(response.headers?.get('content-length')) > 5_000_000) {
          throw providerError(`${sourceName} повернуло завелику відповідь.`, 'INVALID_RESPONSE');
        }
        // Bounded read even when the upstream does not send Content-Length.
        const reader = response.body?.getReader?.();
        if (!reader) return await response.json();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 5_000_000) {
              await reader.cancel();
              throw providerError(`${sourceName} повернуло завелику відповідь.`, 'INVALID_RESPONSE');
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (error) {
        if (error?.code === 'UPSTREAM_UNAVAILABLE' || error?.code === 'INVALID_RESPONSE') throw error;
        if (error instanceof SyntaxError) throw providerError(`${sourceName} повернуло пошкоджені дані.`, 'INVALID_RESPONSE');
        throw providerError(`${sourceName} не відповідає. Спробуйте пізніше.`);
      }
    });
  }

  async function overpass(query) {
    return json(overpassUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ data: query }).toString(),
    }, overpassQueue, 'Джерело OpenStreetMap');
  }

  return {
    async searchPlaces(query) {
      if (typeof query !== 'string' || query.trim().length < 2 || query.trim().length > 180) {
        throw providerError('Введіть назву міста або повну адресу: від 2 до 180 символів.', 'INVALID_INPUT');
      }
      const text = query.trim().replace(/\s+/g, ' ');
      return cache.remember(`places:${text.toLocaleLowerCase('uk')}`, 86_400_000, async () => {
        const url = new URL(nominatimUrl);
        for (const [key, value] of Object.entries({ q: text, format: 'jsonv2', countrycodes: 'ua', limit: '5', 'accept-language': 'uk' })) {
          url.searchParams.set(key, value);
        }
        const data = await json(url.toString(), undefined, nominatimQueue, 'Пошук адрес');
        if (!Array.isArray(data)) throw providerError('Пошук адрес повернув невідомий формат.', 'INVALID_RESPONSE');
        return data.filter(item => item && typeof item === 'object').map(item => ({
          id: `${item.osm_type}/${item.osm_id}`, name: label(item.display_name) || label(item.name),
          lat: number(item.lat), lon: number(item.lon),
        })).filter(place => place.name && OSM_ID.test(place.id) && validCoordinates(place.lat, place.lon)
          && place.lat >= 44.1 && place.lat <= 52.4 && place.lon >= 22 && place.lon <= 40.3).slice(0, 5);
      });
    },

    async nearbyStops(lat, lon, radius = 800) {
      if (!validCoordinates(lat, lon) || !Number.isFinite(radius)) {
        throw providerError('Некоректні координати або радіус пошуку.', 'INVALID_INPUT');
      }
      const meters = Math.min(1_500, Math.max(100, Math.round(radius)));
      return cache.remember(`stops:${lat.toFixed(6)},${lon.toFixed(6)},${meters}`, TTL, async () => {
        const around = `(around:${meters},${lat.toFixed(6)},${lon.toFixed(6)})`;
        const query = `[out:json][timeout:18];(nwr${around}["public_transport"~"^(platform|stop_position|station)$"];nwr${around}["highway"="bus_stop"];nwr${around}["railway"~"^(tram_stop|station|halt)$"];nwr${around}["amenity"="bus_station"];);out body center;`;
        return normalizeStops(await overpass(query), lat, lon, meters);
      });
    },

    async stopRoutes(stop) {
      if (!stop || !OSM_ID.test(stop.id)) throw providerError('Некоректна зупинка.', 'INVALID_INPUT');
      const ids = [...new Set([stop.id, ...(Array.isArray(stop.osmIds) ? stop.osmIds : [])])];
      if (ids.length > 16 || ids.some(id => typeof id !== 'string' || !OSM_ID.test(id))) {
        throw providerError('Некоректні ідентифікатори зупинки.', 'INVALID_INPUT');
      }
      ids.sort();
      return cache.remember(`routes:${ids.join(',')}`, TTL, async () => {
        const selections = ids.map(id => { const [, type, osmId] = id.match(OSM_ID); return `${type}(${osmId});`; }).join('');
        // bn/bw/br cover route membership of nodes, ways and relations respectively.
        const query = `[out:json][timeout:18];(${selections})->.stops;(relation(bn.stops)["type"="route"];relation(bw.stops)["type"="route"];relation(br.stops)["type"="route"];);out tags;`;
        return normalizeRoutes(await overpass(query));
      });
    },

    async liveDnipro(routeFilter = '') {
      if (typeof routeFilter !== 'string' || routeFilter.length > 40) throw providerError('Некоректний номер маршруту.', 'INVALID_INPUT');
      // Cache raw records briefly, then reassess VEHICLE freshness at each request.
      const raw = await cache.remember('dnipro', 20_000, async () => ({
        data: await json(dniproUrl, undefined, dniproQueue, 'GPS-джерело Дніпра'), fetchedAt: now(),
      }));
      const result = normalizeDnipro(raw.data, now());
      result.fetchedAt = new Date(raw.fetchedAt).toISOString();
      const filter = routeFilter.trim().toLocaleLowerCase('uk');
      if (filter) result.vehicles = result.vehicles.filter(vehicle => vehicle.route.toLocaleLowerCase('uk') === filter);
      return result;
    },
  };
}

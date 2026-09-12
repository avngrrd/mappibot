import { distanceMeters, overpassQueue, validCoordinates } from './providers.mjs';

// Data: © OpenStreetMap contributors, ODbL.
// Show https://www.openstreetmap.org/copyright beside the map and route list.
// Geometry model: https://dev.overpass-api.de/overpass-doc/en/full_data/osm_types.html
const KYIV = [50.2, 30.2, 50.7, 30.9];
const UKRAINE = [44.1, 22, 52.4, 40.3];
const MODES = /^(bus|trolleybus|tram|subway|light_rail)$/;
const ID = /^relation\/([1-9]\d{0,15})$/;
const MAX_ROUTES = 1_000;
const MAX_BODY_BYTES = 8_000_000;
const MAX_POINTS = 30_000;
const MAX_MEMBERS = 6_000;
const TTL_MS = 60 * 60 * 1_000;

const fail = (message, code = 'INVALID_RESPONSE') => Object.assign(new Error(message), { code });
const label = value => typeof value === 'string' ? value.trim().slice(0, 500) : '';
const validIdNumber = value => Number.isSafeInteger(value) && value > 0;
const inside = (lat, lon, box) => validCoordinates(lat, lon) && lat >= box[0] && lat <= box[2] && lon >= box[1] && lon <= box[3];
const stopRole = value => /^(?:(?:forward|backward)_)?(?:stop|platform)(?:_|$)/.test(value || '');
const stopTags = tags => /^(platform|stop_position|station)$/.test(tags?.public_transport || '')
  || tags?.highway === 'bus_stop' || /^(platform|tram_stop|station|halt)$/.test(tags?.railway || '')
  || tags?.amenity === 'bus_station';

function stopKind(member, object) {
  const role = /^(?:(?:forward|backward)_)?(stop|platform)(?:_|$)/.exec(member.role || '')?.[1];
  const byRole = role === 'stop' ? 'stop_position' : role;
  const pt = object.tags?.public_transport;
  const byTag = pt === 'stop_position' || pt === 'platform' ? pt
    : object.tags?.railway === 'platform' ? 'platform' : undefined;
  // Contradictory or unknown semantics cannot establish a duplicate pair.
  return byRole && byTag && byRole !== byTag ? undefined : byRole || byTag;
}

function mergeStopPairs(stops) {
  const groups = [];
  const normalizedName = name => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('uk');
  for (const stop of stops) {
    const previous = groups.at(-1);
    const prior = previous?.stop;
    const related = prior && !previous.paired && prior._memberIndex + 1 === stop._memberIndex
      && prior._hasName && stop._hasName && prior._kind && stop._kind && prior._kind !== stop._kind
      && normalizedName(prior.name) === normalizedName(stop.name)
      && distanceMeters(prior.lat, prior.lon, stop.lat, stop.lon) <= 60;
    if (related) {
      const platform = prior._kind === 'platform' ? prior : stop;
      // Keep an actual platform's representative coordinate. Never average the
      // road stop position with the platform, and never merge a third member.
      groups[groups.length - 1] = {
        stop: { ...platform, osmIds: [...new Set([prior.id, stop.id])] }, paired: true,
      };
    } else groups.push({ stop, paired: false });
  }
  return groups.map(({ stop: { _kind, _memberIndex, _hasName, ...stop } }) => stop);
}

function routeInfo(item) {
  if (item?.type !== 'relation' || !validIdNumber(item.id) || item.tags?.type !== 'route' || !MODES.test(item.tags.route || '')) return null;
  const tags = item.tags;
  const id = `relation/${item.id}`;
  return {
    id, ref: label(tags.ref), name: label(tags['name:uk']) || label(tags.name),
    from: label(tags['from:uk']) || label(tags.from), to: label(tags['to:uk']) || label(tags.to),
    mode: tags.route, operator: label(tags['operator:uk']) || label(tags.operator),
    url: `https://www.openstreetmap.org/${id}`,
  };
}

function completeElements(data, maximum) {
  if (!Array.isArray(data?.elements) || data.remark) throw fail('OpenStreetMap повернув неповні дані. Спробуйте пізніше.');
  const sentinels = data.elements.filter(item => item?.type === 'count');
  const elements = data.elements.filter(item => item?.type !== 'count');
  const totalText = sentinels[0]?.tags?.total;
  const total = typeof totalText === 'string' && /^\d+$/.test(totalText) ? Number(totalText) : NaN;
  if (sentinels.length !== 1 || !Number.isSafeInteger(total)) throw fail('OpenStreetMap не підтвердив повноту відповіді.');
  if (total > maximum || elements.length > maximum) throw fail('Дані маршруту перевищують ліміт цієї версії карти.', 'TOO_LARGE');
  if (elements.length !== total) throw fail('OpenStreetMap повернув лише частину запитаних об’єктів.');
  if (elements.some(item => !item || !['node', 'way', 'relation'].includes(item.type) || !validIdNumber(item.id))) {
    throw fail('OpenStreetMap повернув некоректні об’єкти.');
  }
  const keys = new Set(elements.map(item => `${item.type}/${item.id}`));
  if (keys.size !== elements.length) throw fail('OpenStreetMap повернув дубльовані об’єкти.');
  return elements;
}

function catalogFrom(data) {
  const elements = completeElements(data, MAX_ROUTES);
  return elements.map(routeInfo).filter(Boolean)
    .sort((a, b) => a.mode.localeCompare(b.mode) || a.ref.localeCompare(b.ref, 'uk', { numeric: true }) || a.id.localeCompare(b.id));
}

function geometryFrom(data, id, nowMs) {
  const elements = completeElements(data, MAX_MEMBERS + 1);
  const objects = new Map(elements.map(item => [`${item.type}/${item.id}`, item]));
  const relation = objects.get(id);
  const route = routeInfo(relation);
  if (!route || !Array.isArray(relation.members)) throw fail('Джерело не повернуло очікуваний маршрут.');
  if (relation.members.length > MAX_MEMBERS) throw fail('Маршрут має забагато частин для цієї версії карти.', 'TOO_LARGE');
  const lines = [];
  const stops = [];
  let points = 0;
  let touchesKyiv = false;

  const checkedPoint = point => {
    if (!point || !inside(point.lat, point.lon, UKRAINE)) throw fail('Геометрія маршруту містить відсутні або некоректні координати.');
    points += 1;
    if (points > MAX_POINTS) throw fail('Геометрія маршруту перевищує ліміт карти.', 'TOO_LARGE');
    if (inside(point.lat, point.lon, KYIV)) touchesKyiv = true;
    return [point.lat, point.lon];
  };

  for (const [memberIndex, member] of relation.members.entries()) {
    if (!member || !validIdNumber(member.ref) || !['node', 'way', 'relation'].includes(member.type)) throw fail('Некоректний склад маршруту.');
    if (member.type === 'relation') {
      // Recursing through arbitrary nested route relations can expand beyond Kyiv.
      // A stop-area relation is not a line; this version reads node/way stops only.
      if (!stopRole(member.role)) throw fail('Цей маршрут містить вкладені лінії, які ця версія карти ще не підтримує.', 'UNSUPPORTED_GEOMETRY');
      continue;
    }
    const memberId = `${member.type}/${member.ref}`;
    const object = objects.get(memberId);
    if (!object) throw fail('У відповіді OpenStreetMap бракує частини маршруту.');
    const isStop = stopRole(member.role) || stopTags(object.tags);
    const name = label(object.tags?.['name:uk']) || label(object.tags?.name);
    const stopInfo = {
      id: memberId, name: name || 'Зупинка без назви', _hasName: Boolean(name),
      _kind: stopKind(member, object), _memberIndex: memberIndex,
    };
    if (member.type === 'node') {
      const [lat, lon] = checkedPoint(object);
      if (isStop) stops.push({ ...stopInfo, lat, lon });
      continue;
    }
    if (!Array.isArray(object.geometry) || object.geometry.length < 2) throw fail('У відповіді OpenStreetMap бракує геометрії дороги або платформи.');
    const coordinates = object.geometry.map(checkedPoint);
    if (isStop) {
      // A way platform has an area/line, not a point. Represent its footprint by
      // the bounding-box center, the same convention as Overpass `out center`.
      const lats = coordinates.map(point => point[0]);
      const lons = coordinates.map(point => point[1]);
      stops.push({
        ...stopInfo,
        lat: (Math.min(...lats) + Math.max(...lats)) / 2,
        lon: (Math.min(...lons) + Math.max(...lons)) / 2,
      });
    } else {
      // Keep every way separate. Gaps remain gaps; never draw a straight line
      // between disconnected roads, even when the relation order is imperfect.
      lines.push(member.role === 'backward' ? coordinates.reverse() : coordinates);
    }
  }
  if (!touchesKyiv) throw fail('Геометрія цього маршруту не перетинає Київ.');
  if (!lines.length) throw fail('Для цього маршруту ще немає лінії руху в OpenStreetMap.', 'NO_GEOMETRY');
  return { ...route, lines, stops: mergeStopPairs(stops), fetchedAt: new Date(nowMs).toISOString() };
}

export function createMapData({
  fetchImpl = fetch, now = Date.now,
  overpassUrl = 'https://overpass-api.de/api/interpreter',
  userAgent = 'MappiBot/0.1 (personal Ukraine public-transport Telegram bot)',
} = {}) {
  const cache = new Map();
  const inflight = new Map();

  async function remember(key, load) {
    const cached = cache.get(key);
    if (cached && cached.expires > now()) {
      cache.delete(key);
      cache.set(key, cached);
      return structuredClone(cached.value);
    }
    cache.delete(key);
    if (inflight.has(key)) return structuredClone(await inflight.get(key));
    if (inflight.size >= 10) throw fail('Забагато одночасних запитів до карти. Спробуйте пізніше.', 'BUSY');
    const request = Promise.resolve().then(load).then(value => {
      cache.set(key, { value: structuredClone(value), expires: now() + TTL_MS });
      while (cache.size > 33) {
        const evict = [...cache.keys()].find(candidate => candidate !== 'catalog');
        cache.delete(evict);
      }
      return value;
    }).finally(() => inflight.delete(key));
    inflight.set(key, request);
    return structuredClone(await request);
  }

  async function overpass(query) {
    if (query.length > 2_048) throw fail('Запит до карти перевищує ліміт.', 'INVALID_INPUT');
    return overpassQueue.run(async () => {
      try {
        const response = await fetchImpl(overpassUrl, {
          method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json', 'Accept-Language': 'uk', 'User-Agent': userAgent },
          body: new URLSearchParams({ data: query }).toString(),
          signal: AbortSignal.timeout(32_000),
        });
        if (!response.ok) {
          if (response.status === 429 || response.status === 503) overpassQueue.cooldown(response.headers?.get('retry-after'));
          throw fail(`OpenStreetMap тимчасово недоступний (HTTP ${response.status}).`, 'UPSTREAM_UNAVAILABLE');
        }
        if (Number(response.headers?.get('content-length')) > MAX_BODY_BYTES) throw fail('Відповідь карти перевищує ліміт.', 'TOO_LARGE');
        const reader = response.body?.getReader?.();
        if (!reader) {
          const value = await response.json();
          if (Buffer.byteLength(JSON.stringify(value)) > MAX_BODY_BYTES) throw fail('Відповідь карти перевищує ліміт.', 'TOO_LARGE');
          return value;
        }
        let size = 0;
        const chunks = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY_BYTES) {
              await reader.cancel();
              throw fail('Відповідь карти перевищує ліміт.', 'TOO_LARGE');
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (error) {
        if (['UPSTREAM_UNAVAILABLE', 'TOO_LARGE', 'INVALID_RESPONSE'].includes(error?.code)) throw error;
        if (error instanceof SyntaxError) throw fail('OpenStreetMap повернув пошкоджені дані.');
        throw fail('OpenStreetMap не відповідає. Спробуйте пізніше.', 'UPSTREAM_UNAVAILABLE');
      }
    });
  }

  const listRoutes = () => remember('catalog', async () => {
    const query = `[out:json][timeout:25][maxsize:16777216];relation(${KYIV.join(',')})["type"="route"]["route"~"^(bus|trolleybus|tram|subway|light_rail)$"]->.routes;.routes out tags 1001;.routes out count;`;
    return catalogFrom(await overpass(query));
  });

  async function routeGeometry(id) {
    if (typeof id !== 'string' || !ID.test(id) || !Number.isSafeInteger(Number(id.slice(9)))) throw fail('Некоректний ідентифікатор маршруту.', 'INVALID_INPUT');
    const catalog = await listRoutes();
    if (!catalog.some(route => route.id === id)) throw fail('Маршрут відсутній у каталозі Києва.', 'NOT_FOUND');
    return remember(`geometry:${id}`, async () => {
      const osmId = id.slice(9);
      const query = `[out:json][timeout:25][maxsize:16777216];relation(${osmId})->.route;(.route;node(r.route);way(r.route);)->.all;.all out body geom;.all out count;`;
      return geometryFrom(await overpass(query), id, now());
    });
  }

  return { listRoutes, routeGeometry };
}

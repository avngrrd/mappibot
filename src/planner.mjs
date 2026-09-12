import { createHash } from 'node:crypto';
import { distanceMeters, overpassQueue, validCoordinates } from './providers.mjs';
import { createWalking, readJsonBounded } from './walking.mjs';
import { createMetroGraph } from './metro-graph.mjs';

const OSM_SOURCE = 'https://www.openstreetmap.org/copyright';
const MODES = ['bus', 'trolleybus', 'tram', 'subway', 'light_rail'];
const text = value => typeof value === 'string' ? value.trim().slice(0, 250) : '';
const fail = (message, code = 'UPSTREAM_UNAVAILABLE') => Object.assign(new Error(message), { code });
const point = value => ({ lat: value.lat, lon: value.lon, ...(text(value.name) ? { name: text(value.name) } : {}) });
const publicStop = stop => ({ id: stop.id, name: stop.name || 'Зупинка без назви', lat: stop.lat, lon: stop.lon });
const kyiv = value => validCoordinates(value?.lat, value?.lon) && value.lat >= 50.2 && value.lat <= 50.7 && value.lon >= 30.2 && value.lon <= 30.9;
const roleType = role => /^(stop|platform)(?:_(entry|exit)_only)?$/.exec(role || '');
const normalizedName = name => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('uk');
const distance = (a, b) => distanceMeters(a.lat, a.lon, b.lat, b.lon);

function endpointQuery(p, prefix, modePattern) {
  const around = `(around:800,${p.lat.toFixed(6)},${p.lon.toFixed(6)})`;
  const filter = `["type"="route"]["route"~"^(${modePattern})$"]`;
  return `(nwr${around}["public_transport"~"^(platform|stop_position)$"];nwr${around}["highway"="bus_stop"];nwr${around}["railway"~"^(tram_stop|platform|station)$"];)->.${prefix}Stops;`
    + `(relation(bn.${prefix}Stops)${filter};relation(bw.${prefix}Stops)${filter};relation(br.${prefix}Stops)${filter};)->.${prefix}Routes;`;
}

function candidateQuery(from, to, modes) {
  return '[out:json][timeout:25][maxsize:33554432];'
    + endpointQuery(from, 'a', modes.join('|')) + endpointQuery(to, 'b', modes.join('|'))
    + '(.aRoutes;.bRoutes;)->.routes;(node(r.routes);'
    + ['platform', 'platform_entry_only', 'platform_exit_only', 'stop', 'stop_entry_only', 'stop_exit_only'].map(role => `way(r.routes:"${role}");`).join('')
    + 'way(r.routes)["public_transport"~"^(platform|stop_position)$"];way(r.routes)["highway"="bus_stop"];way(r.routes)["railway"="platform"];)->.stops;'
    + '(.routes;.stops;)->.all;.all out body center;.all out count;';
}

/** Read ordered PTv2 boarding/alighting roles, not unordered nearby map stops. */
export function normalizePlannerTopology(data) {
  if (!Array.isArray(data?.elements) || data.remark || data.elements.length > 20_000) throw fail('OpenStreetMap повернув неповні дані для пошуку маршруту.');
  const counts = data.elements.filter(item => item?.type === 'count');
  if (counts.length !== 1 || !/^\d+$/.test(counts[0].tags?.total || '') || Number(counts[0].tags.total) !== data.elements.length - 1) throw fail('Не вдалося перевірити повноту даних маршрутів.');
  const elements = data.elements.filter(item => item?.type !== 'count');
  if (elements.some(item => !item || !['node', 'way', 'relation'].includes(item.type) || !Number.isSafeInteger(item.id) || item.id <= 0)) throw fail('Некоректні дані маршрутів.');
  const objects = new Map(elements.map(item => [`${item.type}/${item.id}`, item]));
  if (objects.size !== elements.length) throw fail('Дубльовані дані маршрутів.');
  const relations = elements.filter(item => item.type === 'relation');
  if (relations.length > 80) throw fail('Поруч забагато маршрутів. Звузьте вибір видів транспорту.', 'TOO_LARGE');
  const routes = [];
  const excluded = {};
  const skip = reason => { excluded[reason] = (excluded[reason] || 0) + 1; };
  for (const relation of relations) {
    const tags = relation.tags || {};
    if (tags.type !== 'route' || !MODES.includes(tags.route)) { skip('unsupported_mode'); continue; }
    if (tags['public_transport:version'] !== '2') { skip('unordered_stops'); continue; }
    if (['proposed', 'disused', 'abandoned'].includes(tags.state) || tags.disused === 'yes') { skip('inactive_tag'); continue; }
    if (!Array.isArray(relation.members) || relation.members.length > 6_000
      || relation.members.some(member => !member || !Number.isSafeInteger(member.ref) || member.ref <= 0
        || !['node', 'way'].includes(member.type) || ['forward', 'backward'].includes(member.role))) { skip('ambiguous_direction'); continue; }
    const rawStops = [];
    let invalid = false;
    for (const [index, member] of relation.members.entries()) {
      const role = roleType(member.role);
      if (!role || !['node', 'way'].includes(member.type)) continue;
      const object = objects.get(`${member.type}/${member.ref}`);
      const lat = object?.lat ?? object?.center?.lat, lon = object?.lon ?? object?.center?.lon;
      if (!object || !validCoordinates(lat, lon) || lat < 44.1 || lat > 52.4 || lon < 22 || lon > 40.3) { invalid = true; break; }
      const pt = object.tags?.public_transport;
      const knownKind = role[1] === 'stop' ? 'stop_position' : 'platform';
      const conflict = ['platform', 'stop_position'].includes(pt) && pt !== knownKind;
      rawStops.push({ id: `${member.type}/${member.ref}`, name: text(object.tags?.['name:uk']) || text(object.tags?.name), lat, lon, index,
        kind: conflict ? null : role[1], board: role[2] !== 'exit', alight: role[2] !== 'entry' });
    }
    if (invalid || rawStops.length > 800) { skip('missing_or_excessive_stops'); continue; }
    const stops = [];
    for (const stop of rawStops) {
      const previous = stops.at(-1);
      if (previous && !previous.paired && stop.index === previous.index + 1 && stop.kind && previous.kind && stop.kind !== previous.kind
        && stop.name && normalizedName(stop.name) === normalizedName(previous.name) && distance(stop, previous) <= 60) {
        const platform = stop.kind === 'platform' ? stop : previous;
        stops[stops.length - 1] = { ...platform, board: stop.board && previous.board, alight: stop.alight && previous.alight, paired: true };
      } else stops.push(stop);
    }
    if (stops.length < 2) { skip('fewer_than_two_stops'); continue; }
    routes.push({ id: `relation/${relation.id}`, ref: text(tags.ref), mode: tags.route,
      name: text(tags['name:uk']) || text(tags.name), stops, source: OSM_SOURCE });
  }
  return { routes, candidateRoutes: relations.length, usableRoutes: routes.length, excluded };
}

function legOf(leg) {
  const { route, board, alight } = leg;
  return { routeId: route.id, ref: route.ref, name: route.name, mode: route.mode,
    board: publicStop(board.stop), alight: publicStop(alight.stop), boardIndex: board.index, alightIndex: alight.index,
    stopCount: alight.index - board.index, source: route.source,
    ...(route.segments ? { lines: route.segments.slice(board.index, alight.index).flat() } : {}) };
}

/** Pure topology search: directed stop occurrences, direct trips or one transfer. */
export function findTopologyJourneys(routes, transferPairs, { from, to, maxTransfers = 1, sort = 'transfers' }) {
  const options = new Map();
  const departures = new Map();
  const arrivals = [];
  const transfers = new Map();
  for (const [a, b] of transferPairs) {
    if (!transfers.has(a)) transfers.set(a, []);
    if (!transfers.has(b)) transfers.set(b, []);
    transfers.get(a).push(b); transfers.get(b).push(a);
  }
  let combinations = 0;
  const put = legs => {
    if (++combinations > 150_000) throw fail('Забагато варіантів пересадок. Звузьте вибір транспорту.', 'TOO_LARGE');
    if (legs.some(leg => leg.board.stop.id === leg.alight.stop.id) || legs[0].board.stop.id === legs.at(-1).alight.stop.id) return;
    const walk = legs[0].board.walk + legs.at(-1).alight.walk;
    const count = legs.reduce((n, leg) => n + leg.alight.index - leg.board.index, 0);
    const key = legs.map(leg => leg.route.id).join('>');
    const prior = options.get(key);
    if (!prior || walk < prior.walk || (walk === prior.walk && count < prior.stopCount)) options.set(key, { legs, walk, stopCount: count, transfers: legs.length - 1 });
  };
  for (const route of routes) {
    let bestBoard;
    for (const [index, stop] of route.stops.entries()) {
      const endWalk = distance(to, stop);
      if (stop.alight && bestBoard && stop.id !== bestBoard.stop.id) {
        const alight = { stop, index, walk: endWalk };
        const leg = { route, board: bestBoard, alight };
        if (endWalk <= 800) put([leg]);
        if (maxTransfers) arrivals.push(leg);
      }
      const walk = distance(from, stop);
      if (stop.board && walk <= 800 && (!bestBoard || walk <= bestBoard.walk)) bestBoard = { stop, index, walk };
    }
    if (maxTransfers) {
      let bestAlight;
      for (let index = route.stops.length - 1; index >= 0; index--) {
        const stop = route.stops[index];
        if (stop.board && bestAlight && stop.id !== bestAlight.stop.id) {
          if (!departures.has(stop.id)) departures.set(stop.id, []);
          departures.get(stop.id).push({ route, board: { stop, index }, alight: bestAlight });
        }
        const walk = distance(to, stop);
        if (stop.alight && walk <= 800 && (!bestAlight || walk <= bestAlight.walk)) bestAlight = { stop, index, walk };
      }
    }
  }
  for (const first of arrivals) for (const id of [first.alight.stop.id, ...(transfers.get(first.alight.stop.id) || [])]) {
    for (const second of departures.get(id) || []) if (first.route.id !== second.route.id) put([first, second]);
  }
  // These are only straight-line lower bounds. Keep alternatives until actual
  // foot routing can reveal a barrier, detour or an unmapped pedestrian path.
  const ranked = [...options.values()];
  ranked.sort((a, b) => sort === 'walk' ? a.walk - b.walk || a.transfers - b.transfers || a.stopCount - b.stopCount
    : a.transfers - b.transfers || a.walk - b.walk || a.stopCount - b.stopCount);
  return ranked.slice(0, 3).map(option => {
    const legs = option.legs.map(legOf);
    const walks = [
      { kind: 'access', from: point(from), to: legs[0].board, meters: Math.round(option.legs[0].board.walk), verified: false },
      ...(legs.length === 2 ? [{ kind: 'transfer', from: legs[0].alight, to: legs[1].board,
        meters: legs[0].alight.id === legs[1].board.id ? 0 : null,
        verified: legs[0].alight.id === legs[1].board.id }] : []),
      { kind: 'egress', from: legs.at(-1).alight, to: point(to), meters: Math.round(option.legs.at(-1).alight.walk), verified: false },
    ];
    return { id: createHash('sha256').update(legs.map(leg => `${leg.routeId}:${leg.boardIndex}:${leg.alightIndex}`).join('|')).digest('hex').slice(0, 20),
      transfers: option.transfers, accessEgressMeters: Math.round(option.walk), distanceKind: 'straight_line', walkingVerified: false, legs, walks };
  });
}

function withDeadline(promise, deadline) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(fail('Джерело маршрутів не відповідає.')), Math.max(1, deadline - Date.now())); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createPlanner({ fetchImpl = fetch, now = Date.now, overpassUrl = 'https://overpass-api.de/api/interpreter',
  userAgent = 'MappiBot/0.1 (https://github.com/avngrrd/mappibot)', metroGraph, walking, metroBaseUrl, walkingUrl, mapData } = {}) {
  const metro = metroGraph || createMetroGraph({ fetchImpl, now, userAgent, baseUrl: metroBaseUrl });
  const foot = walking || createWalking({ fetchImpl, now, userAgent, url: walkingUrl });
  const cache = new Map();
  const inflight = new Map();

  async function topology(from, to, modes, deadline) {
    const key = `${from.lat.toFixed(6)},${from.lon.toFixed(6)}>${to.lat.toFixed(6)},${to.lon.toFixed(6)}:${modes.join(',')}`;
    const previous = cache.get(key);
    if (previous?.expires > now()) return structuredClone(previous.value);
    cache.delete(key);
    if (inflight.has(key)) return structuredClone(await inflight.get(key));
    if (inflight.size >= 4) throw fail('Забагато одночасних пошуків.', 'BUSY');
    const query = candidateQuery(from, to, modes);
    if (query.length > 3_000) throw fail('Завеликий запит.', 'INVALID_INPUT');
    const task = withDeadline(overpassQueue.run(async () => {
      const timeout = Math.min(28_000, deadline - Date.now());
      if (timeout < 1_000) throw fail('Джерело маршрутів зайняте.');
      const response = await fetchImpl(overpassUrl, { method: 'POST', body: new URLSearchParams({ data: query }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeout), redirect: 'error' });
      if (!response.ok) {
        if ([429, 503].includes(response.status)) overpassQueue.cooldown(response.headers?.get('retry-after'));
        throw fail('OpenStreetMap тимчасово недоступний.');
      }
      return normalizePlannerTopology(await readJsonBounded(response, 6_000_000));
    }), deadline).then(value => {
      cache.set(key, { value, expires: now() + 900_000 });
      while (cache.size > 64) cache.delete(cache.keys().next().value);
      return value;
    }).finally(() => inflight.delete(key));
    inflight.set(key, task);
    return structuredClone(await task);
  }

  return {
    async plan(input) {
      if (!input || !kyiv(input.from) || !kyiv(input.to)) throw fail('Оберіть початок і кінець поїздки в Києві.', 'INVALID_INPUT');
      if (distance(input.from, input.to) < 15) throw fail('Початок і кінець поїздки майже збігаються.', 'INVALID_INPUT');
      const modes = input.modes === undefined ? [...MODES] : input.modes;
      const maxTransfers = input.maxTransfers ?? 1;
      const sort = input.sort ?? 'transfers';
      if (!Array.isArray(modes) || !modes.length || modes.length > MODES.length || modes.some(mode => !MODES.includes(mode))
        || ![0, 1].includes(maxTransfers) || !['transfers', 'walk'].includes(sort)) throw fail('Некоректні параметри пошуку маршруту.', 'INVALID_INPUT');
      const uniqueModes = [...new Set(modes)].sort();
      const from = point(input.from), to = point(input.to);
      const deadline = Date.now() + 53_000;
      const sourceDeadline = Date.now() + 30_000;
      const metroWanted = uniqueModes.includes('subway');
      const surfaceWanted = uniqueModes.some(mode => mode !== 'subway');
      const [osmResult, metroResult] = await Promise.allSettled([
        surfaceWanted ? topology(from, to, uniqueModes, sourceDeadline) : Promise.resolve(null),
        metroWanted ? metro.load() : Promise.resolve(null),
      ]);
      let osm = osmResult.status === 'fulfilled' ? osmResult.value : null;
      const network = metroResult.status === 'fulfilled' ? metroResult.value : null;
      if (!surfaceWanted && metroWanted && !network) {
        try { osm = await topology(from, to, ['subway'], sourceDeadline); } catch { /* Return an explicit source error below. */ }
      }
      if (!osm && !network) throw fail('Не вдалося завантажити дані для пошуку поїздки. Спробуйте пізніше.');
      const routes = [
        ...(osm?.routes || []).filter(route => uniqueModes.includes(route.mode) && !(network && route.mode === 'subway')),
        ...(network?.routes || []),
      ];
      let itineraries = findTopologyJourneys(routes, network?.transferPairs || [], { from, to, maxTransfers, sort });
      const checked = new Map();
      let rejectedWalking = 0;
      for (const itinerary of itineraries) {
        for (const walk of itinerary.walks) {
          if (walk.kind === 'transfer') continue;
          const key = `${walk.from.lat.toFixed(6)},${walk.from.lon.toFixed(6)}>${walk.to.lat.toFixed(6)},${walk.to.lon.toFixed(6)}`;
          if (!checked.has(key) && checked.size < 6) checked.set(key, Promise.resolve().then(() => foot.route(walk.from, walk.to, { deadline }))
            .catch(() => ({ meters: walk.meters, verified: false, reason: 'unavailable' })));
          if (checked.has(key)) Object.assign(walk, await checked.get(key));
        }
        const access = itinerary.walks.filter(walk => walk.kind !== 'transfer');
        itinerary.accessEgressMeters = access.reduce((sum, walk) => sum + walk.meters, 0);
        itinerary.distanceKind = access.every(walk => walk.verified) ? 'routed' : access.some(walk => walk.verified) ? 'mixed' : 'straight_line';
        itinerary.walkingVerified = itinerary.walks.every(walk => walk.verified);
      }
      itineraries = itineraries.filter(itinerary => {
        if (itinerary.walks.some(walk => walk.reason === 'no_route')) { rejectedWalking++; return false; }
        return true;
      });
      itineraries = itineraries.filter(candidate => !candidate.walkingVerified || !itineraries.some(other => other !== candidate && other.walkingVerified
        && other.transfers <= candidate.transfers && other.accessEgressMeters <= candidate.accessEgressMeters
        && (other.transfers < candidate.transfers || other.accessEgressMeters < candidate.accessEgressMeters)));
      itineraries.sort((a, b) => sort === 'walk' ? Number(b.walkingVerified) - Number(a.walkingVerified) || a.accessEgressMeters - b.accessEgressMeters || a.transfers - b.transfers
        : a.transfers - b.transfers || a.accessEgressMeters - b.accessEgressMeters);
      if (mapData?.rememberCandidateRoutes) {
        const selectedIds = new Set(itineraries.flatMap(itinerary => itinerary.legs.map(leg => leg.routeId)));
        mapData.rememberCandidateRoutes(routes.filter(route => selectedIds.has(route.id) && /^relation\//.test(route.id)));
      }
      const notices = ['Це варіанти за схемами маршрутів. Час відправлення, роботу рейсів і вартість не перевірено.'];
      if (itineraries.some(itinerary => itinerary.distanceKind !== 'routed')) notices.push('Частину пішого шляху не перевірено; для неї вказана відстань навпростець.');
      if (itineraries.some(itinerary => itinerary.walks.some(walk => walk.kind === 'transfer' && walk.meters === null))) notices.push('Для переходу між станціями метро відстань і час не визначені.');
      if (surfaceWanted && !osm) notices.push('Наземні маршрути зараз недоступні; показано доступні варіанти метро.');
      if (metroWanted && !network) notices.push('Офіційна схема метро зараз недоступна.');
      if (osm && Object.keys(osm.excluded).length) notices.push('Маршрути без підтвердженого порядку зупинок у даних пропущено.');
      if (rejectedWalking) notices.push('Частину варіантів відхилено, бо не знайдено пішого підходу до зупинки.');
      notices.push('Пошук обмежений прямими поїздками, пересадками на тій самій зупинці та офіційними переходами метро.');
      return { itineraries, fetchedAt: new Date(now()).toISOString(), source: itineraries[0]?.legs[0]?.source || network?.source || OSM_SOURCE,
        sources: [...new Set([...routes.map(route => route.source), ...itineraries.flatMap(itinerary => itinerary.walks.map(walk => walk.source).filter(Boolean))])], notices,
        coverage: { candidateRoutes: osm?.candidateRoutes || 0, usableOsmRoutes: osm?.usableRoutes || 0, excluded: osm?.excluded || {},
          metroStations: network?.stationCount || 0, walkingLegsChecked: checked.size, rejectedWalking, exhaustive: false } };
    },
  };
}

import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const DEFAULT_URL = 'http://193.23.225.214:732/api/realtime';
const SOURCE_URL = 'https://data.kyivcity.gov.ua/dataset/dani-pro-mistseznakhodzhennia-miskoho-elektrychnoho-ta-pasazhyrskoho-avtomobilnoho-tra-dep-transport';
const CACHE_MS = 20_000;
const MAX_AGE_MS = 180_000;
const MAX_FUTURE_MS = 60_000;
const MAX_BODY_BYTES = 5_000_000;
const MODES = { 1: 'Трамвай', 2: 'Тролейбус', 3: 'Автобус' };

const text = value => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '';
const normalize = value => text(value).toLocaleUpperCase('uk-UA').replace(/[\s№-]/g, '');

/**
 * Official Kyiv feed: vehicle.vehicle.label is the public route number;
 * vehicle.trip.routeId is an internal ID, e.g. 3_9 means bus route 104.
 * This provider-specific label convention is documented at SOURCE_URL.
 * Neither a headsign nor an arrival prediction is supplied by this feed.
 * https://gtfs.org/documentation/realtime/language-bindings/nodejs/
 */
export function createKyivProvider({
  fetchImpl = fetch,
  now = Date.now,
  url = DEFAULT_URL,
  userAgent = 'MappiBot/0.1'
} = {}) {
  let cache;
  let pending;

  async function refresh() {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': userAgent, Accept: 'application/x-protobuf, application/octet-stream' },
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) throw new Error('GPS Києва тимчасово недоступний. Спробуйте пізніше.');
    const length = Number(response.headers?.get?.('content-length'));
    if (length > MAX_BODY_BYTES) throw new Error('Завелика відповідь GPS Києва.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BODY_BYTES) throw new Error('Завелика відповідь GPS Києва.');
    let feed;
    try {
      feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes);
    } catch {
      throw new Error('Не вдалося прочитати GPS Києва. Спробуйте пізніше.');
    }
    // A differential update cannot safely replace a complete vehicle snapshot.
    if (!feed.header || feed.header.incrementality === 1) {
      throw new Error('GPS Києва не містить повного знімка транспорту.');
    }
    cache = { feed, fetchedAt: now() };
    return cache;
  }

  return async function liveKyiv(routeFilter = '') {
    const requestTime = now();
    if (!cache || requestTime < cache.fetchedAt || requestTime - cache.fetchedAt >= CACHE_MS) {
      if (!pending) {
        pending = refresh().finally(() => { pending = undefined; });
      }
      // A failed refresh never reuses an expired snapshot as live data.
      await pending;
    }
    const snapshot = cache;
    const currentTime = now();
    const filter = normalize(String(routeFilter ?? ''));
    const vehicles = new Map();
    let staleCount = 0;
    let invalidCount = 0;

    for (const entity of snapshot.feed.entity ?? []) {
      if (entity.isDeleted || !entity.vehicle) continue;
      const record = entity.vehicle;
      const routeId = text(record.trip?.routeId);
      const publicRoute = text(record.vehicle?.label);
      const route = publicRoute || (routeId ? `ID ${routeId}` : 'Невідомий маршрут');
      if (filter && ![publicRoute, routeId, route].some(value => normalize(value) === filter)) continue;
      const lat = record.position?.latitude;
      const lon = record.position?.longitude;
      // The upstream currently includes fresh coordinates outside Ukraine.
      // Never transform or relocate them: reject every point outside Kyiv.
      if (!Number.isFinite(lat) || !Number.isFinite(lon)
        || lat < 50.2 || lat > 50.7 || lon < 30.2 || lon > 30.9) {
        invalidCount++;
        continue;
      }
      // Do not substitute the feed header timestamp for a missing observation.
      const timestamp = Number(record.timestamp);
      const observationTime = timestamp * 1000;
      if (!Number.isSafeInteger(timestamp) || timestamp <= 0
        || currentTime - observationTime > MAX_AGE_MS
        || observationTime - currentTime > MAX_FUTURE_MS) {
        staleCount++;
        continue;
      }
      const upstreamId = text(record.vehicle?.id) || text(entity.id);
      if (!upstreamId) { invalidCount++; continue; }
      const id = `kyiv:${upstreamId}`;
      const mode = MODES[routeId.split('_')[0]] || 'Транспорт';
      const board = text(record.vehicle?.licensePlate);
      const name = `${mode} · ${publicRoute ? `№ ${publicRoute}` : `маршрут ${route}`} ${board ? `· борт ${board}` : ''}`.trim();
      const vehicle = {
        id, route, routeIsPublicNumber: Boolean(publicRoute), name, lat, lon,
        // Slight clock skew is tolerated, but the UI must not show future data.
        updatedAt: new Date(Math.min(observationTime, currentTime)).toISOString()
      };
      if (!vehicles.has(id) || vehicles.get(id).updatedAt < vehicle.updatedAt) vehicles.set(id, vehicle);
    }
    return {
      vehicles: [...vehicles.values()],
      fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
      staleCount,
      source: `КП «Київпастранс», відкриті дані Києва: ${SOURCE_URL}. Джерело містить GPS-помилки; відкинуто точок із некоректними координатами або ID: ${invalidCount}. Показано лише спостереження до 3 хв у межах Києва. Прогноз прибуття відсутній.`
    };
  };
}

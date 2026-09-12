const DEFAULT_BASE = 'https://gisserver-stage.kyivcity.gov.ua/mayno/rest/services/KYIV_API/transport_public/MapServer';
const SOURCE = 'Відкриті дані Києва, ІАС «Майно»: https://data.kyivcity.gov.ua/dataset/rozklad-rukhu-miskoho-elektrychnoho-ta-avtomobilnoho-transportu-dep-transport';
const SYSTEMS = {
  metro: { name: 'Метро', stations: 4, times: 13, intervals: 14 },
  rail: { name: 'Київська кільцева електричка', stations: 10, times: 20 },
  funicular: { name: 'Фунікулер', stations: 7, times: 17, intervals: 18 }
};
const STATION_LAYERS = new Set([4, 7, 10]);
const ALLOWED_LAYERS = new Set([4, 7, 10, 13, 14, 17, 18, 20]);
const MAX_BYTES = 2_000_000;
const MAX_ROWS = 2_000;
const SCHEDULE_TTL = 15 * 60_000;
const CATALOG_TTL = 6 * 60 * 60_000;
const UNAVAILABLE = 'Офіційні розклади Києва тимчасово недоступні. Спробуйте пізніше.';
const NOTICE = 'Плановий розклад, час за Києвом. Затримки, тривоги та оперативні зміни руху тут не враховані. Дату завершення дії джерело не вказує.';
const clean = (value, max = 160) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
const code = value => {
  const result = typeof value === 'number' ? String(value) : clean(value, 64);
  return /^[A-Za-z0-9_]{1,64}$/.test(result) ? result : '';
};
function clockTime(value) {
  const input = clean(value, 12);
  const match = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/.exec(input);
  if (!match || Number(match[1]) > 47) return undefined;
  return `${match[1].padStart(2, '0')}:${match[2]}${match[3] && match[3] !== '00' ? `:${match[3]}` : ''}`;
}
function interval(value, days, period) {
  const label = clean(value, 40);
  const parts = label.split(/\s*[-–]\s*/);
  if (!parts.length || parts.length > 2 || !parts.every(part => /^\d{1,3}:[0-5]\d$/.test(part))) return null;
  const duration = parts[0].split(':').map(Number);
  return { days, period, minutes: parts.length === 1 ? duration[0] + duration[1] / 60 : null, label: `${label} хв:сек` };
}

async function boundedJson(response) {
  if (!response.ok || Number(response.headers?.get?.('content-length')) > MAX_BYTES) {
    await response.body?.cancel?.();
    throw new Error(UNAVAILABLE);
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error(UNAVAILABLE);
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error(UNAVAILABLE); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw new Error(UNAVAILABLE); }
}

/** Published GIS schedules. These tables contain planned times, not GTFS-RT arrivals. */
export function createKyivSchedules({
  fetchImpl = fetch, now = Date.now, baseUrl = DEFAULT_BASE, userAgent = 'MappiBot/0.1'
} = {}) {
  const cache = new Map();
  const pending = new Map();
  const base = String(baseUrl).replace(/\/$/, '');

  async function layer(id) {
    if (!ALLOWED_LAYERS.has(id)) throw new Error(UNAVAILABLE);
    const current = now();
    const old = cache.get(id);
    const ttl = STATION_LAYERS.has(id) ? CATALOG_TTL : SCHEDULE_TTL;
    if (old && current >= old.fetchedAt && current - old.fetchedAt < ttl) return old;
    if (!pending.has(id)) {
      const request = (async () => {
        try {
          const url = `${base}/${id}/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&resultRecordCount=${MAX_ROWS}&f=pjson`;
          const response = await fetchImpl(url, {
            signal: AbortSignal.timeout(10_000),
            headers: { Accept: 'application/json', 'User-Agent': userAgent }
          });
          const data = await boundedJson(response);
          if (data.error || data.exceededTransferLimit || !Array.isArray(data.features)
            || !data.features.length || data.features.length > MAX_ROWS) throw new Error(UNAVAILABLE);
          const snapshot = { rows: data.features, fetchedAt: now() };
          cache.set(id, snapshot);
          return snapshot;
        } catch { throw new Error(UNAVAILABLE); }
      })().finally(() => pending.delete(id));
      pending.set(id, request);
    }
    // Failed refreshes do not silently return schedules whose cache has expired.
    return pending.get(id);
  }

  async function stationsFor(system) {
    const snapshot = await layer(SYSTEMS[system].stations);
    const stations = new Map();
    for (const row of snapshot.rows) {
      const attributes = row?.attributes ?? {};
      const id = code(attributes.code1);
      const name = clean(attributes.name);
      const lat = row?.geometry?.y;
      const lon = row?.geometry?.x;
      if (!id || !name || !Number.isFinite(lat) || !Number.isFinite(lon)
        || lat < 50.2 || lat > 50.7 || lon < 30.2 || lon > 30.9) continue;
      const station = { id, name, lat, lon };
      if (clean(attributes.line)) station.line = clean(attributes.line);
      stations.set(id, station);
    }
    if (!stations.size) throw new Error(UNAVAILABLE);
    return { stations, fetchedAt: snapshot.fetchedAt };
  }

  async function catalog() {
    const snapshots = await Promise.all(Object.keys(SYSTEMS).map(async id => {
      const snapshot = await stationsFor(id);
      return { id, ...snapshot };
    }));
    return {
      systems: snapshots.map(({ id, stations }) => ({
        id, name: SYSTEMS[id].name,
        stations: [...stations.values()].sort((a, b) => a.name.localeCompare(b.name, 'uk'))
      })),
      source: SOURCE,
      fetchedAt: new Date(Math.min(...snapshots.map(x => x.fetchedAt))).toISOString()
    };
  }

  async function timetable(system, stationId) {
    if (typeof system !== 'string' || !Object.hasOwn(SYSTEMS, system)) throw new Error('Оберіть метро, електричку або фунікулер.');
    if (typeof stationId !== 'string' || code(stationId) !== stationId) throw new Error('Оберіть станцію зі списку.');
    const stationSnapshot = await stationsFor(system);
    const station = stationSnapshot.stations.get(stationId);
    if (!station) throw new Error('Станцію не знайдено в офіційному каталозі.');
    const config = SYSTEMS[system];
    const [times, periods] = await Promise.all([
      layer(config.times), config.intervals ? layer(config.intervals) : Promise.resolve(null)
    ]);
    const rows = times.rows.map(row => row?.attributes ?? {}).filter(row => code(row.code1) === stationId);
    const directions = [];
    if (system === 'rail') {
      const groups = new Map();
      for (const row of rows) {
        const time = clockTime(row.departure);
        const name = clean(row.num_route);
        const direction = clean(row.napryamok);
        const days = clean(row.type, 80);
        const train = clean(row.train, 40);
        if (row.actual !== 1 || !time || !name || !direction || !days || !train) continue;
        const key = `${name}|${direction}`;
        if (!groups.has(key)) groups.set(key, {
          id: `rail:${encodeURIComponent(key)}`, name: `${name} · ${direction}`, departures: []
        });
        const departure = { train, time, days, destination: name };
        const arrival = clockTime(row.arrival);
        if (arrival) departure.arrival = arrival;
        groups.get(key).departures.push(departure);
      }
      for (const group of groups.values()) {
        const unique = new Map(group.departures.map(row => [`${row.train}|${row.time}|${row.days}`, row]));
        group.departures = [...unique.values()].sort((a, b) => a.time.localeCompare(b.time) || a.train.localeCompare(b.train));
        directions.push(group);
      }
      directions.sort((a, b) => a.name.localeCompare(b.name, 'uk'));
    } else {
      const axes = {
        'Прямий': { id: 'forward', prefix: 'st' }, 'Зворотній': { id: 'reverse', prefix: 'rv' },
        'Вверх': { id: 'up', prefix: 'st' }, 'Донизу': { id: 'down', prefix: 'rv' }
      };
      const seen = new Set();
      for (const row of rows) {
        const name = clean(row.napryamok);
        const axis = axes[name];
        if (!axis || seen.has(axis.id)) continue;
        seen.add(axis.id);
        const direction = { id: axis.id, name, intervals: [] };
        const first = clockTime(row.first_trn1) || clockTime(row.first_trn2);
        const last = clockTime(row.last_trn1) || clockTime(row.last_trn2);
        if (first) direction.first = first;
        if (last) direction.last = last;
        for (const feature of periods.rows) {
          const periodRow = feature?.attributes ?? {};
          if (clean(periodRow.line) !== clean(row.line)) continue;
          const period = clean(periodRow.timeperiod, 30);
          if (!/^\d{2}:[0-5]\d\s*[-–]\s*\d{2}:[0-5]\d$/.test(period)) continue;
          for (const [suffix, days] of [['weekday', 'Робочі дні'], ['holiday', 'Вихідні дні']]) {
            const item = interval(periodRow[`${axis.prefix}_${suffix}`], days, period);
            if (item) direction.intervals.push(item);
          }
        }
        direction.intervals.sort((a, b) => a.period.localeCompare(b.period) || a.days.localeCompare(b.days, 'uk'));
        directions.push(direction);
      }
    }
    return {
      system, station, directions, source: SOURCE,
      fetchedAt: new Date(Math.min(stationSnapshot.fetchedAt, times.fetchedAt, periods?.fetchedAt ?? Infinity)).toISOString(),
      notice: directions.length ? NOTICE : `Для цієї станції джерело не містить відправлень. ${NOTICE}`
    };
  }
  return { catalog, timetable };
}

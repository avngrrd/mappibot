const DEFAULT_URL = 'https://api.eway.in.ua/';
const SOURCE = 'EasyWay API: https://www.eway.in.ua/ua/api';
const MAX_BYTES = 2_000_000;
const MAX_CACHE = 128;
const REQUEST_GAP_MS = 1_100;
const METHODS = {
  'user.GetMyInfo': 60_000,
  'cities.GetRoutesList': 300_000,
  'routes.GetRouteInfo': 600_000,
  'routes.GetRouteGPS': 15_000,
  'stops.GetStopInfo': 15_000,
  'routes.Search': 60_000
};
const LANGUAGES = new Set(['ua', 'ru', 'en', 'md', 'bg', 'rs', 'hr']);
const TRANSPORTS = new Set(['bus', 'trol', 'tram', 'metro', 'train', 'boat']);
const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));
class EasyWayError extends Error {
  constructor(message, code = 'UPSTREAM_UNAVAILABLE') { super(message); this.name = 'EasyWayError'; this.code = code; }
}
const unavailable = () => new EasyWayError('EasyWay API тимчасово недоступний. Спробуйте пізніше.');
const accessError = () => new EasyWayError('EasyWay не дозволив запит. Перевірте обліковий запис, доступ до Києва й функцій та ліміти API.', 'ACCESS_OR_QUOTA');
function identifier(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof id !== 'string' || !/^\d{1,12}$/.test(id)) throw new EasyWayError('Потрібен числовий ID EasyWay.', 'INVALID_INPUT');
  return id;
}

/** Use only this form if a diagnostic needs to identify a request URL. */
export function redactEasyWayUrl(value) {
  try {
    const url = new URL(value);
    url.username = ''; url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/login|password|token|secret|authorization/i.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return url.toString();
  } catch { return '[REDACTED EasyWay URL]'; }
}

async function readJson(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) {
    await response.body?.cancel?.(); throw unavailable();
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw unavailable();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); throw unavailable(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
  catch { throw new EasyWayError('EasyWay повернув неочікуваний формат відповіді.', 'INVALID_RESPONSE'); }
  if (!data || typeof data !== 'object') throw unavailable();
  return data;
}
function safeData(data) {
  // Transport schemas need no credentials. Never forward unexpected account secrets.
  let count = 0;
  function visit(value, depth) {
    if (depth > 40 || ++count > 50_000) throw unavailable();
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      if (/^(login|password|token|access_token|authorization|secret|__proto__|constructor|prototype)$/i.test(key)) delete value[key];
      else visit(value[key], depth + 1);
    }
  }
  visit(data, 0);
  return data;
}

/**
 * Server-only documented API adapter. JSON is preserved because published XML
 * samples and prose use different field names; validate real JSON after access.
 * https://www.eway.in.ua/ua/api — required login/password, JSON, protocol v1.0.
 */
export function createEasyWay({
  login, password, fetchImpl = fetch, now = Date.now, url = DEFAULT_URL, language = 'ua'
} = {}) {
  let endpoint;
  try { endpoint = new URL(url); } catch { throw new EasyWayError('Некоректна адреса EasyWay API.', 'INVALID_CONFIG'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new EasyWayError('EasyWay API потребує HTTPS-адресу без облікових даних і параметрів.', 'INVALID_CONFIG');
  }
  if (!LANGUAGES.has(language)) throw new EasyWayError('Непідтримувана мова EasyWay API.', 'INVALID_CONFIG');
  const configured = typeof login === 'string' && login.trim().length > 0 && login.length <= 512
    && typeof password === 'string' && password.length > 0 && password.length <= 2_048;
  const cache = new Map();
  const pending = new Map();
  let queue = Promise.resolve();
  let queued = 0;
  let lastStarted = -Infinity;
  let blockedUntil = 0;

  async function enqueue(task) {
    if (queued >= 8) throw new EasyWayError('Забагато запитів EasyWay. Спробуйте за кілька секунд.', 'BUSY');
    queued++;
    const run = queue.catch(() => {}).then(async () => {
      if (now() < blockedUntil) throw accessError();
      const delay = Math.min(REQUEST_GAP_MS, Math.max(0, lastStarted + REQUEST_GAP_MS - now()));
      if (delay) await sleep(delay);
      lastStarted = now();
      return task();
    }).finally(() => { queued--; });
    queue = run.catch(() => {});
    return run;
  }

  async function request(method, parameters = {}) {
    if (!configured) throw new EasyWayError('EasyWay API ще не підключено: потрібні EASYWAY_LOGIN і EASYWAY_PASSWORD.', 'NOT_CONFIGURED');
    if (!Object.hasOwn(METHODS, method)) throw new EasyWayError('Непідтримувана функція EasyWay.', 'INVALID_INPUT');
    const key = JSON.stringify([method, parameters, language]);
    const snapshot = cache.get(key);
    const current = now();
    if (snapshot && current >= snapshot.time && current - snapshot.time < METHODS[method]) return structuredClone(snapshot.result);
    if (!pending.has(key)) {
      const task = enqueue(async () => {
        try {
          const requestUrl = new URL(endpoint);
          const params = { ...parameters, login, password, function: method, lang: language, format: 'json', gzip: '0', v: '1.0' };
          for (const [name, value] of Object.entries(params)) requestUrl.searchParams.set(name, String(value));
          const response = await fetchImpl(requestUrl.toString(), {
            signal: AbortSignal.timeout(10_000), redirect: 'error',
            headers: { Accept: 'application/json', 'User-Agent': 'MappiBot/0.1' }
          });
          if (!response.ok) {
            await response.body?.cancel?.();
            if ([401, 403, 429].includes(response.status)) {
              cache.clear(); blockedUntil = now() + 60_000; throw accessError();
            }
            throw unavailable();
          }
          const data = await readJson(response);
          const error = data.error ?? data.response?.error;
          if (error) {
            const code = Number(error.code ?? error.id);
            if (code === 2) { cache.clear(); blockedUntil = now() + 60_000; throw accessError(); }
            throw new EasyWayError('EasyWay відхилив запит. Перевірте параметри та версію API.', 'API_ERROR');
          }
          const fetchedAt = now();
          const result = { method, ...(parameters.city ? { city: parameters.city } : {}), data: safeData(data), fetchedAt: new Date(fetchedAt).toISOString(), source: SOURCE };
          cache.delete(key);
          cache.set(key, { time: fetchedAt, result });
          while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
          return result;
        } catch (error) {
          // Fetch errors often embed the full URL; do not keep their message/cause.
          if (error instanceof EasyWayError) throw error;
          throw unavailable();
        }
      }).finally(() => pending.delete(key));
      pending.set(key, task);
    }
    return structuredClone(await pending.get(key));
  }

  async function status() {
    if (!configured) return { configured: false, connected: false, message: 'Потрібні облікові дані EasyWay API.', source: SOURCE };
    try {
      const result = await request('user.GetMyInfo');
      const permissionRoot = result.data.response ?? result.data;
      if (!Object.hasOwn(permissionRoot, 'permission') && !Object.hasOwn(permissionRoot, 'permissions')) {
        return { configured: true, connected: false, message: 'EasyWay повернув JSON, але формат прав доступу ще не підтверджено.', code: 'UNVERIFIED_SCHEMA', source: SOURCE };
      }
      return { configured: true, connected: true, checkedAt: result.fetchedAt, permissions: result.data, source: SOURCE };
    } catch (error) {
      return { configured: true, connected: false, message: error.message, code: error.code, source: SOURCE };
    }
  }
  const routes = () => request('cities.GetRoutesList', { city: 'kyiv' });
  const route = id => request('routes.GetRouteInfo', { city: 'kyiv', id: identifier(id) });
  const stop = id => request('stops.GetStopInfo', { city: 'kyiv', id: identifier(id) });
  async function gps(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 5) throw new EasyWayError('Оберіть від 1 до 5 маршрутів EasyWay.', 'INVALID_INPUT');
    const routeIds = [...new Set(ids.map(identifier))];
    const results = [];
    for (const id of routeIds) results.push({ id, ...await request('routes.GetRouteGPS', { city: 'kyiv', id }) });
    return { routes: results, source: SOURCE, notice: 'Актуальність визначає поле data_relevance EasyWay. Час запиту не є часом GPS-спостереження.' };
  }
  function searchJourney(query = {}) {
    const parameters = { city: 'kyiv' };
    for (const [name, low, high] of [['start_lat', 50.2, 50.7], ['stop_lat', 50.2, 50.7], ['start_lng', 30.2, 30.9], ['stop_lng', 30.2, 30.9]]) {
      const raw = query?.[name];
      const value = typeof raw === 'number' || (typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw)) ? Number(raw) : NaN;
      if (!Number.isFinite(value) || value < low || value > high) throw new EasyWayError('Потрібні коректні координати початку й кінця поїздки в Києві.', 'INVALID_INPUT');
      parameters[name] = value;
    }
    if (query.transports !== undefined) {
      const choices = Array.isArray(query.transports) ? query.transports : typeof query.transports === 'string' ? query.transports.split(',') : [];
      if (!choices.length || choices.length > 6 || choices.some(x => !TRANSPORTS.has(x))) throw new EasyWayError('Непідтримуваний тип транспорту EasyWay.', 'INVALID_INPUT');
      parameters.transports = [...new Set(choices)].join(',');
    }
    const type = query.type ?? 'optimal';
    if (!['optimal', 'fast', 'cheap'].includes(type)) throw new EasyWayError('Непідтримуваний спосіб пошуку EasyWay.', 'INVALID_INPUT');
    parameters.type = type;
    if (query.direct !== undefined && typeof query.direct !== 'boolean') throw new EasyWayError('Параметр direct має бути логічним значенням.', 'INVALID_INPUT');
    parameters.direct = query.direct ?? false;
    const count = query.results_count ?? 10;
    if (!Number.isInteger(count) || count < 1 || count > 25) throw new EasyWayError('Кількість варіантів має бути від 1 до 25.', 'INVALID_INPUT');
    parameters.results_count = count;
    return request('routes.Search', parameters);
  }
  return { configured, status, routes, route, gps, stop, searchJourney };
}

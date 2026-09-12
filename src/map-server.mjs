import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const secretEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && b.length > 0
  && timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/** Verify Telegram's raw initData; never trust initDataUnsafe or a client user ID. */
export function validateInitData(raw, botToken, now = Date.now()) {
  if (typeof raw !== 'string' || raw.length > 16_384 || !botToken) return null;
  const params = new URLSearchParams(raw);
  if ([...params.keys()].some((key, index, keys) => keys.indexOf(key) !== index)) return null;
  const hash = params.get('hash');
  if (!/^[a-f0-9]{64}$/i.test(hash || '')) return null;
  params.delete('hash');
  params.sort();
  const check = [...params].map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;
  const date = Number(params.get('auth_date'));
  if (!Number.isSafeInteger(date) || date <= 0 || now - date * 1000 > 3_600_000 || date * 1000 - now > 60_000) return null;
  try {
    const user = JSON.parse(params.get('user'));
    return Number.isSafeInteger(user?.id) && user.id > 0 ? String(user.id) : null;
  } catch { return null; }
}

const ASSETS = new Map([
  ['/', ['web/index.html', 'text/html']],
  ['/index.html', ['web/index.html', 'text/html']],
  ['/app.css', ['web/app.css', 'text/css']],
  ['/app.js', ['web/app.js', 'text/javascript']],
  ['/journeys.js', ['web/journeys.js', 'text/javascript']],
  ['/schedules.js', ['web/schedules.js', 'text/javascript']],
  ['/features.css', ['web/features.css', 'text/css']],
  ['/vendor/leaflet/leaflet.js', ['node_modules/leaflet/dist/leaflet.js', 'text/javascript']],
  ['/vendor/leaflet/leaflet.css', ['node_modules/leaflet/dist/leaflet.css', 'text/css']],
  ...['layers.png', 'layers-2x.png', 'marker-icon.png', 'marker-icon-2x.png', 'marker-shadow.png']
    .map(name => [`/vendor/leaflet/images/${name}`, [`node_modules/leaflet/dist/images/${name}`, 'image/png']]),
]);

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(request) {
  if (!(request.headers['content-type'] || '').startsWith('application/json')) throw new ApiError(415, 'Потрібен JSON.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 24_000) throw new ApiError(413, 'Завеликий запит.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'Некоректний запит.'); }
}

/** The tunnel connects over loopback, so loopback itself NEVER grants API access. */
export function createMapServer({ botToken, previewKey = '', store, allowedUserIds = [], providers, mapData, planner, schedules, easyway, now = Date.now }) {
  const sessions = new Map();
  const allowed = new Set(allowedUserIds.map(String));
  const authorized = id => allowed.has(id) || Object.hasOwn(store.users, id);
  let authWindow = 0, authAttempts = 0, active = 0;
  const reply = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  };

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org; base-uri 'none'; object-src 'none'; form-action 'self'");
    response.setHeader('Permissions-Policy', 'camera=(), microphone=()');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'Метод не підтримується.');
        const asset = ASSETS.get(url.pathname);
        if (!asset) throw new ApiError(404, 'Не знайдено.');
        const bytes = await readFile(path.join(ROOT, asset[0]));
        response.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        response.end(request.method === 'HEAD' ? undefined : bytes);
        return;
      }
      if (url.pathname === '/api/health' && request.method === 'GET') return reply(response, 200, { ok: true });
      if (url.pathname === '/api/auth' && request.method === 'POST') {
        if (now() - authWindow >= 60_000) { authWindow = now(); authAttempts = 0; }
        if (++authAttempts > 120) throw new ApiError(429, 'Забагато спроб. Зачекайте хвилину.');
        const body = await readJson(request);
        const preview = previewKey.length >= 32 && secretEqual(body?.previewKey, previewKey);
        const id = preview ? null : validateInitData(body?.initData, botToken, now());
        if (!preview && (!id || !authorized(id))) throw new ApiError(403, 'Відкрийте карту в боті після входу за запрошенням.');
        for (const [key, value] of sessions) if (value.expires <= now()) sessions.delete(key);
        if (sessions.size >= 256) sessions.delete(sessions.keys().next().value);
        const token = randomBytes(32).toString('base64url');
        sessions.set(token, { id, preview, expires: now() + 4 * 3_600_000, window: now(), requests: 0 });
        return reply(response, 200, { token });
      }
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || '')?.[1];
      const session = sessions.get(token);
      if (!session || session.expires <= now() || (!session.preview && !authorized(session.id))) {
        sessions.delete(token);
        throw new ApiError(401, 'Сесію завершено. Відкрийте карту в боті ще раз.');
      }
      const postOnly = ['/api/journeys', '/api/stop-routes'].includes(url.pathname);
      if (request.method !== (postOnly ? 'POST' : 'GET')) throw new ApiError(405, 'Метод не підтримується.');
      if (now() - session.window >= 60_000) { session.window = now(); session.requests = 0; }
      if (++session.requests > 90 || active >= 16) throw new ApiError(429, 'Забагато запитів. Спробуйте за кілька секунд.');
      active++;
      try {
        switch (url.pathname) {
          case '/api/capabilities': return reply(response, 200, {
            journeys: Boolean(planner), schedules: Boolean(schedules),
            easyway: { configured: Boolean(easyway?.configured), connected: false,
              notice: 'Доступ до API EasyWay потребує окремого облікового запису та перевірки наданих даних.' }
          });
          case '/api/journeys': {
            if (!planner) throw new ApiError(503, 'Планування ще недоступне.');
            const body = await readJson(request);
            const point = value => value && typeof value.lat === 'number' && typeof value.lon === 'number'
              && Number.isFinite(value.lat) && Number.isFinite(value.lon)
              && value.lat >= 50.2 && value.lat <= 50.7 && value.lon >= 30.2 && value.lon <= 30.9;
            const modes = ['bus', 'trolleybus', 'tram', 'subway', 'light_rail'];
            if (!point(body?.from) || !point(body?.to)) throw new ApiError(400, 'Оберіть дві точки в межах Києва.');
            if (!Array.isArray(body.modes) || !body.modes.length || body.modes.length > 5 || body.modes.some(mode => !modes.includes(mode))
              || ![0, 1].includes(body.maxTransfers) || !['transfers', 'walk'].includes(body.sort)) throw new ApiError(400, 'Перевірте параметри поїздки.');
            return reply(response, 200, await planner.plan({
              from: { lat: body.from.lat, lon: body.from.lon }, to: { lat: body.to.lat, lon: body.to.lon },
              modes: [...new Set(body.modes)], maxTransfers: body.maxTransfers, sort: body.sort
            }));
          }
          case '/api/stop-routes': {
            const body = await readJson(request);
            const stop = body?.stop;
            const validId = id => typeof id === 'string' && /^(node|way|relation)\/[1-9]\d{0,14}$/.test(id);
            if (!validId(stop?.id) || (stop.osmIds !== undefined && (!Array.isArray(stop.osmIds) || stop.osmIds.length > 20 || stop.osmIds.some(id => !validId(id))))) {
              throw new ApiError(400, 'Некоректна зупинка.');
            }
            return reply(response, 200, { routes: await providers.stopRoutes({ id: stop.id, ...(stop.osmIds ? { osmIds: stop.osmIds } : {}) }) });
          }
          case '/api/schedules/catalog': {
            if (!schedules) throw new ApiError(503, 'Розклади ще недоступні.');
            return reply(response, 200, await schedules.catalog());
          }
          case '/api/schedules': {
            if (!schedules) throw new ApiError(503, 'Розклади ще недоступні.');
            const system = url.searchParams.get('system'), station = url.searchParams.get('station');
            if (!['metro', 'rail', 'funicular'].includes(system) || !/^[A-Za-z0-9_-]{1,40}$/.test(station || '')) throw new ApiError(400, 'Оберіть станцію з переліку.');
            const catalog = await schedules.catalog();
            if (!catalog.systems.find(item => item.id === system)?.stations.some(item => String(item.id) === station)) throw new ApiError(400, 'Станції немає в переліку.');
            return reply(response, 200, await schedules.timetable(system, station));
          }
          case '/api/live': return reply(response, 200, await providers.liveKyiv());
          case '/api/routes': return reply(response, 200, { routes: await mapData.listRoutes() });
          case '/api/route': {
            const id = url.searchParams.get('id') || '';
            if (!/^relation\/[1-9]\d{0,14}$/.test(id)) throw new ApiError(400, 'Некоректний маршрут.');
            return reply(response, 200, await mapData.routeGeometry(id));
          }
          case '/api/stops': {
            const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
            if (!url.searchParams.has('lat') || !url.searchParams.has('lon') || !Number.isFinite(lat) || !Number.isFinite(lon)
              || lat < 44 || lat > 53 || lon < 22 || lon > 41) throw new ApiError(400, 'Оберіть місце в Україні.');
            return reply(response, 200, { stops: await providers.nearbyStops(lat, lon) });
          }
          case '/api/search': {
            const q = (url.searchParams.get('q') || '').trim();
            const query = q.includes(',') ? q : `${q}, Київ`;
            if (q.length < 2 || query.length > 180) throw new ApiError(400, 'Введіть коротшу назву місця (від 2 символів).');
            return reply(response, 200, { places: await providers.searchPlaces(query) });
          }
          default: throw new ApiError(404, 'Не знайдено.');
        }
      } finally { active--; }
    } catch (error) {
      // Provider/request errors may contain a URL or personal input: return only a controlled message.
      const invalidInput = error?.code === 'INVALID_INPUT';
      if (!response.headersSent) reply(response, error instanceof ApiError ? error.status : invalidInput ? 400 : 503,
        { error: error instanceof ApiError ? error.message : invalidInput ? 'Перевірте точки та параметри поїздки.' : 'Джерело даних зараз недоступне. Спробуйте ще раз.' });
      else response.end();
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 40;
  server.revokeUser = id => { for (const [token, session] of sessions) if (session.id === String(id)) sessions.delete(token); };
  return server;
}

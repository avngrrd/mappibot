/* Mappi Mini App. No GPS interpolation, ETA estimates, or background geolocation. */
(() => {
  'use strict';

  // Runs before the third-party Telegram SDK. Preview credentials leave the URL
  // immediately and stay only in this closure until the authentication request.
  let previewKey = new URLSearchParams(location.hash.slice(1)).get('preview');
  if (previewKey !== null) history.replaceState(null, '', location.pathname + location.search);

  const SESSION_KEY = 'mappi.session.v1';
  const FAVORITES_KEY = 'mappi.savedStops.v1';
  const MAX_AGE_MS = 180_000;
  const KYIV_BOUNDS = [[50.335, 30.345], [50.585, 30.705]];
  const SOURCE_URL = 'https://data.kyivcity.gov.ua/dataset/dani-pro-mistseznakhodzhennia-miskoho-elektrychnoho-ta-pasazhyrskoho-avtomobilnoho-tra-dep-transport';
  const MODE_NAMES = { bus: 'Автобус', trolleybus: 'Тролейбус', tram: 'Трамвай', subway: 'Метро', train: 'Поїзд', unknown: 'Транспорт' };
  const MODE_COLORS = { bus: '#16aaa4', trolleybus: '#477fc0', tram: '#9465bf', subway: '#dc7e46', unknown: '#537c97' };
  const state = {
    token: null, map: null, tg: null, activeTab: 'map-panel', vehicles: [], markers: new Map(),
    liveBusy: false, liveFailed: false, fetchedAt: null, routes: null, routesBusy: false,
    mode: 'all', selectedRoute: null, routeSequence: 0, nearbySequence: 0, searchSequence: 0,
    favorites: [], routeLayer: null, stopsLayer: null, placeLayer: null, locationLayer: null,
    activeStop: null, toastTimer: null,
  };
  const $ = (id) => document.getElementById(id);
  const clean = (value, limit = 180) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit);
  const normalizeRef = (value) => clean(value, 50).toLocaleUpperCase('uk-UA').replace(/[\s№-]/g, '');
  const validPosition = (point) => point && Number.isFinite(point.lat) && Number.isFinite(point.lon)
    && point.lat >= -90 && point.lat <= 90 && point.lon >= -180 && point.lon <= 180;
  const modeOf = (value) => ({ metro: 'subway', trolley: 'trolleybus', 'Трамвай': 'tram', 'Тролейбус': 'trolleybus', 'Автобус': 'bus' })[value]
    || (Object.hasOwn(MODE_NAMES, value) ? value : 'unknown');
  const fresh = (vehicle) => validPosition(vehicle) && typeof vehicle.updatedAt === 'string'
    && Number.isFinite(Date.parse(vehicle.updatedAt)) && Date.now() - Date.parse(vehicle.updatedAt) <= MAX_AGE_MS
    && Date.parse(vehicle.updatedAt) - Date.now() <= 60_000;
  const clock = (value) => Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '—';
  const age = (value) => {
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
    return seconds < 60 ? `${seconds} с тому` : `${Math.floor(seconds / 60)} хв ${seconds % 60} с тому`;
  };
  function node(tag, className, value) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (value !== undefined) result.textContent = value;
    return result;
  }
  function button(label, className, action) {
    const result = node('button', className, label);
    result.type = 'button';
    result.addEventListener('click', action);
    return result;
  }
  function pinIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', 'M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z');
    const circle = document.createElementNS(svg.namespaceURI, 'circle');
    circle.setAttribute('cx', '12'); circle.setAttribute('cy', '10'); circle.setAttribute('r', '2.5');
    svg.append(path, circle);
    return svg;
  }
  function routeNumber(route, small = false) {
    return node('span', `route-number mode-${modeOf(route.mode)}${small ? ' is-small' : ''}`, clean(route.ref || '—', 15));
  }
  function routeTitle(route) {
    if (route.from && route.to) return `${clean(route.from, 120)} → ${clean(route.to, 120)}`;
    return clean(route.name || 'Напрямок не зазначено', 240);
  }
  function sourceLink(label = 'Відкриті дані Києва ↗') {
    const link = node('a', 'source-link', label);
    link.href = SOURCE_URL; link.target = '_blank'; link.rel = 'noopener';
    return link;
  }
  function loading(container, label) {
    const row = node('div', 'loading-state');
    row.setAttribute('role', 'status');
    row.append(node('span', 'spinner'), node('span', '', label));
    container.replaceChildren(row);
  }
  function empty(container, title, description, retry) {
    const box = node('div', 'empty-state');
    box.append(node('span', 'empty-symbol', retry ? '↻' : '⌁'), node('h2', '', title), node('p', '', description));
    if (retry) box.append(button('Спробувати ще раз', 'button button-secondary', retry));
    container.replaceChildren(box);
  }
  function toast(message) {
    clearTimeout(state.toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
  }
  class ApiError extends Error {
    constructor(status) { super('Request failed'); this.status = status; }
  }
  function clearSession() {
    state.token = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* Private storage may be disabled. */ }
  }
  function showWelcome(message, status = 'Доступ відкривається через приватного бота') {
    $('welcome-message').textContent = message;
    $('auth-status').textContent = status;
    $('welcome').hidden = false;
    $('application').hidden = true;
  }
  async function api(path, options = {}) {
    const headers = { Accept: 'application/json' };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    if (options.body) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(path, {
        method: options.method || 'GET', headers,
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(25_000), cache: 'no-store', redirect: 'error',
      });
    } catch { throw new ApiError(0); }
    if (!response.ok) {
      if ([401, 403].includes(response.status) && path !== '/api/auth') {
        clearSession();
        showWelcome('Сеанс карти завершився. Відкрийте її знову через кнопку в Telegram-боті.');
      }
      throw new ApiError(response.status);
    }
    try { return await response.json(); } catch { throw new ApiError(0); }
  }
  async function authenticate() {
    const initData = state.tg?.initData;
    let credentials;
    if (previewKey) credentials = { previewKey };
    else if (initData) credentials = { initData };
    else {
      try { state.token = sessionStorage.getItem(SESSION_KEY); } catch { /* No stored session. */ }
      return Boolean(state.token);
    }
    try {
      const result = await api('/api/auth', { method: 'POST', body: credentials });
      if (typeof result.token !== 'string' || !result.token) throw new ApiError(401);
      state.token = result.token;
      try { sessionStorage.setItem(SESSION_KEY, state.token); } catch { /* In-memory session still works. */ }
      return true;
    } finally { previewKey = null; credentials = null; }
  }
  function applySafeArea() {
    const tg = state.tg;
    const top = Math.max(Number(tg?.safeAreaInset?.top) || 0, Number(tg?.contentSafeAreaInset?.top) || 0);
    const bottom = Math.max(Number(tg?.safeAreaInset?.bottom) || 0, Number(tg?.contentSafeAreaInset?.bottom) || 0);
    document.documentElement.style.setProperty('--tg-safe-top', `${Math.min(top, 150)}px`);
    document.documentElement.style.setProperty('--tg-safe-bottom', `${Math.min(bottom, 100)}px`);
    state.map?.invalidateSize();
  }
  function setExpanded(expanded) {
    $('sheet').classList.toggle('is-collapsed', !expanded);
    $('sheet-toggle').setAttribute('aria-expanded', String(expanded));
    $('sheet-toggle').setAttribute('aria-label', expanded ? 'Згорнути панель' : 'Розгорнути панель');
  }
  function switchTab(id, expand = true) {
    state.activeTab = id;
    for (const tab of document.querySelectorAll('.tab')) {
      const selected = tab.dataset.tab === id;
      tab.classList.toggle('is-active', selected);
      if (selected) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
    }
    for (const panel of document.querySelectorAll('.panel')) panel.hidden = panel.id !== id;
    const headings = {
      'map-panel': ['КИЇВ · ЗАРАЗ', 'Транспорт на карті'], 'routes-panel': ['КИЇВ · МАРШРУТИ', 'Оберіть свій маршрут'],
      'search-panel': ['УКРАЇНА · ПОШУК', 'Знайдіть місце'], 'favorites-panel': ['НА ЦЬОМУ ПРИСТРОЇ', 'Обрані зупинки'],
    };
    $('sheet-kicker').textContent = headings[id][0];
    $('sheet-title').textContent = headings[id][1];
    setExpanded(expand);
    if (id === 'routes-panel' && !state.routes) loadRoutes();
    if (id === 'favorites-panel') renderFavorites();
  }
  function fitPoints(bounds, zoom = 16) {
    if (!bounds?.isValid()) return;
    const desktop = window.innerWidth >= 650;
    state.map.fitBounds(bounds, {
      paddingTopLeft: desktop ? [425, 155] : [30, 178],
      paddingBottomRight: desktop ? [75, 35] : [65, $('sheet').getBoundingClientRect().height + 24],
      maxZoom: zoom, animate: false,
    });
  }
  function focusPosition(point, zoom = 16) {
    if (!validPosition(point)) return;
    fitPoints(L.latLngBounds([[point.lat, point.lon]]), zoom);
  }
  function initializeMap() {
    state.map = L.map('map', { zoomControl: false, attributionControl: false, minZoom: 5, maxZoom: 19, preferCanvas: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
      updateWhenIdle: true, keepBuffer: 2,
    }).addTo(state.map);
    L.control.attribution({ prefix: false, position: 'bottomright' }).addTo(state.map);
    state.routeLayer = L.featureGroup().addTo(state.map);
    state.stopsLayer = L.featureGroup().addTo(state.map);
    state.placeLayer = L.featureGroup().addTo(state.map);
    state.locationLayer = L.featureGroup().addTo(state.map);
    fitPoints(L.latLngBounds(KYIV_BOUNDS), 12);
    new ResizeObserver(() => {
      document.documentElement.style.setProperty('--sheet-size', `${Math.round($('sheet').getBoundingClientRect().height)}px`);
    }).observe($('sheet'));
    state.map.on('popupopen', () => updateAges());
    $('zoom-in').addEventListener('click', () => state.map.zoomIn());
    $('zoom-out').addEventListener('click', () => state.map.zoomOut());
  }
  function vehicleMatches(vehicle) {
    const route = state.selectedRoute;
    if (!route) return true;
    if (!route.ref || vehicle.routeIsPublicNumber !== true || normalizeRef(vehicle.route) !== normalizeRef(route.ref)) return false;
    const routeMode = modeOf(route.mode);
    const vehicleMode = modeOf(vehicle.mode);
    return routeMode === 'unknown' || vehicleMode === 'unknown' || routeMode === vehicleMode;
  }
  function vehicleIcon(vehicle) {
    const isPublic = vehicle.routeIsPublicNumber === true;
    const marker = node('div', `vehicle-marker mode-${modeOf(vehicle.mode)}${isPublic ? '' : ' is-id'}`, isPublic ? clean(vehicle.route, 9) : 'ID');
    marker.setAttribute('aria-label', `${isPublic ? 'Маршрут' : 'Технічний ID маршруту'} ${clean(vehicle.route, 30)}`);
    return L.divIcon({ html: marker, className: 'vehicle-icon', iconSize: [36, 32], iconAnchor: [16, 30], popupAnchor: [0, -30] });
  }
  function vehiclePopup(vehicle) {
    const box = node('div', 'map-popup');
    box.append(node('h3', '', `${vehicle.routeIsPublicNumber === true ? 'Маршрут' : 'ID маршруту'} ${clean(vehicle.route, 40)}`));
    box.append(node('p', '', clean(vehicle.name, 150)));
    const freshness = node('p', 'popup-age', age(vehicle.updatedAt));
    freshness.dataset.observedAt = vehicle.updatedAt;
    box.append(freshness, node('p', '', `GPS о ${clock(vehicle.updatedAt)} · Київський час`));
    box.append(node('p', '', 'КП «Київпастранс» · міське GPS-джерело. Без прогнозу прибуття.'), sourceLink());
    return box;
  }
  function updateAges() {
    for (const label of document.querySelectorAll('[data-observed-at]')) {
      const timestamp = Date.parse(label.dataset.observedAt);
      label.textContent = Date.now() - timestamp > MAX_AGE_MS ? 'Позиція застаріла — оновіть GPS' : age(label.dataset.observedAt);
    }
  }
  function renderVehicles() {
    if (!state.map || !state.token) return;
    state.vehicles = state.vehicles.filter(fresh).slice(0, 2000);
    const visible = state.vehicles.filter(vehicleMatches);
    const ids = new Set(visible.map((vehicle) => clean(vehicle.id, 120)));
    for (const [id, marker] of state.markers) {
      if (!ids.has(id)) { state.map.removeLayer(marker); state.markers.delete(id); }
    }
    for (const vehicle of visible) {
      const id = clean(vehicle.id, 120);
      if (!id) continue;
      let marker = state.markers.get(id);
      if (!marker) {
        marker = L.marker([vehicle.lat, vehicle.lon], {
          icon: vehicleIcon(vehicle), title: clean(vehicle.name || vehicle.route, 150), keyboard: true, riseOnHover: true,
        }).addTo(state.map);
        state.markers.set(id, marker);
        marker.bindPopup(vehiclePopup(vehicle), { maxWidth: 260, autoPanPaddingTopLeft: [15, 95], autoPanPaddingBottomRight: [15, 190] });
      } else {
        marker.setLatLng([vehicle.lat, vehicle.lon]);
        if (marker._mappiTimestamp !== vehicle.updatedAt) marker.setPopupContent(vehiclePopup(vehicle));
      }
      const labelKey = `${vehicle.routeIsPublicNumber}:${vehicle.route}:${vehicle.mode}`;
      if (marker._mappiLabel !== labelKey) {
        marker.setIcon(vehicleIcon(vehicle));
        marker.getElement()?.setAttribute('title', clean(vehicle.name || vehicle.route, 150));
        marker._mappiLabel = labelKey;
      }
      marker._mappiTimestamp = vehicle.updatedAt;
    }
    const count = visible.length;
    const routePrefix = state.selectedRoute ? `${state.selectedRoute.ref ? `№ ${clean(state.selectedRoute.ref, 12)}` : 'Маршрут'} · ` : '';
    $('live-status').textContent = state.liveFailed
      ? `${routePrefix}GPS недоступний${count ? ` · ${count} актуальних` : ''}`
      : count ? `${routePrefix}${count} GPS-позицій${state.selectedRoute ? '' : ' · Київ'}` : `${routePrefix}Свіжих GPS-позицій немає`;
    $('connection-dot').classList.remove('is-loading');
    $('connection-dot').classList.toggle('is-offline', state.liveFailed || count === 0);
    $('live-count').textContent = count ? `${count} машин на карті` : 'Свіжих позицій поки немає';
    $('live-updated').textContent = state.liveFailed ? 'Спробуйте кнопку оновлення на карті'
      : state.fetchedAt ? `Знімок отримано о ${clock(state.fetchedAt)} · до 3 хв` : 'Джерело охоплює лише частину транспорту';
    if (state.activeTab === 'map-panel') $('sheet-kicker').textContent = `КИЇВ · ${count} GPS-ПОЗИЦІЙ`;
    updateAges();
  }
  async function refreshLive(manual = false) {
    if (!state.token || state.liveBusy || document.hidden) return;
    state.liveBusy = true;
    $('refresh').disabled = true;
    $('refresh').classList.add('is-loading');
    try {
      const feed = await api('/api/live');
      state.vehicles = Array.isArray(feed.vehicles) ? feed.vehicles.filter(fresh).slice(0, 2000) : [];
      state.fetchedAt = feed.fetchedAt;
      state.liveFailed = false;
      if (manual) toast(state.vehicles.length ? 'GPS-позиції оновлено' : 'У джерелі немає свіжих позицій. Це не означає, що рейсів немає.');
    } catch (error) {
      state.liveFailed = true;
      if (manual && ![401, 403].includes(error.status)) toast('GPS-джерело недоступне. Спробуйте оновити трохи пізніше.');
    } finally {
      state.liveBusy = false;
      $('refresh').disabled = false;
      $('refresh').classList.remove('is-loading');
      renderVehicles();
    }
  }
  async function loadRoutes() {
    if (!state.token || state.routesBusy) return;
    state.routesBusy = true;
    loading($('routes-results'), 'Завантажуємо маршрути Києва…');
    try {
      const result = await api('/api/routes');
      state.routes = Array.isArray(result.routes) ? result.routes.slice(0, 2500) : [];
      renderRoutes();
    } catch {
      empty($('routes-results'), 'Маршрути зараз недоступні', 'Не вдалося отримати каталог OpenStreetMap. Карта й GPS працюють окремо.', loadRoutes);
    } finally { state.routesBusy = false; }
  }
  function renderRoutes() {
    const query = $('route-query').value.trim().toLocaleLowerCase('uk-UA');
    const matches = (state.routes ?? []).filter((route) => {
      if (state.mode !== 'all' && modeOf(route.mode) !== state.mode) return false;
      return !query || [route.ref, route.name, route.from, route.to].some((value) => clean(value, 300).toLocaleLowerCase('uk-UA').includes(query));
    });
    $('routes-count').textContent = `Напрямків: ${matches.length}`;
    if (!matches.length) {
      empty($('routes-results'), 'Маршрут не знайдено', query ? 'Спробуйте інший номер або тип транспорту. В OpenStreetMap можуть бути не всі маршрути.' : 'Для цього типу транспорту в каталозі немає маршрутів.');
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const route of matches) {
      const card = button('', 'result-card', () => selectRoute(route));
      const copy = node('span', 'result-copy');
      copy.append(node('strong', '', routeTitle(route)), node('p', '', `${MODE_NAMES[modeOf(route.mode)]}${route.operator ? ` · ${clean(route.operator, 65)}` : ''}`));
      card.append(routeNumber(route), copy, node('span', 'result-arrow', '›'));
      fragment.append(card);
    }
    $('routes-results').replaceChildren(fragment);
  }
  function clearRoute(showCatalog = true) {
    state.routeSequence++;
    state.selectedRoute = null;
    state.routeLayer?.clearLayers();
    $('route-map-label').hidden = true;
    if (showCatalog) { $('route-detail').hidden = true; $('route-catalog').hidden = false; }
    renderVehicles();
  }
  async function selectRoute(route) {
    clearRoute(false);
    state.nearbySequence++;
    $('nearby').disabled = false;
    const sequence = ++state.routeSequence;
    $('route-catalog').hidden = true;
    $('route-detail').hidden = false;
    const back = button('← Усі маршрути', 'route-detail-back', () => clearRoute());
    const loadingBox = node('div');
    loading(loadingBox, `Завантажуємо маршрут ${clean(route.ref, 15)}…`);
    $('route-detail').replaceChildren(back, loadingBox);
    try {
      const detail = await api(`/api/route?${new URLSearchParams({ id: route.id })}`);
      if (sequence !== state.routeSequence) return;
      state.selectedRoute = detail;
      state.stopsLayer.clearLayers();
      state.placeLayer.clearLayers();
      const color = MODE_COLORS[modeOf(detail.mode)] || MODE_COLORS.unknown;
      for (const line of Array.isArray(detail.lines) ? detail.lines : []) {
        if (!Array.isArray(line) || line.length < 2 || !line.every((point) => Array.isArray(point) && validPosition({ lat: point[0], lon: point[1] }))) continue;
        L.polyline(line, { color: '#ffffff', weight: 8, opacity: .9, interactive: false }).addTo(state.routeLayer);
        L.polyline(line, { color, weight: 4.5, opacity: .92, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(state.routeLayer);
      }
      for (const stop of (detail.stops ?? []).filter(validPosition)) makeStopMarker(stop, state.routeLayer);
      $('route-map-ref').textContent = clean(detail.ref || '—', 15);
      $('route-map-ref').className = `route-number mode-${modeOf(detail.mode)}`;
      $('route-map-name').textContent = routeTitle(detail);
      $('route-map-label').hidden = false;
      renderRouteDetail(detail);
      renderVehicles();
      if (window.innerWidth < 650) setExpanded(false);
      if (state.routeLayer.getBounds().isValid()) fitPoints(state.routeLayer.getBounds(), 15);
      else toast('У маршруті немає геометрії або координат зупинок.');
    } catch (error) {
      if (sequence !== state.routeSequence) return;
      empty(loadingBox, 'Не вдалося відкрити маршрут', error.status === 404 ? 'Цей напрямок більше не доступний у каталозі.' : 'Джерело маршруту тимчасово недоступне.', () => selectRoute(route));
    }
  }
  function renderRouteDetail(route) {
    const back = button('← Усі маршрути', 'route-detail-back', () => clearRoute());
    const heading = node('div', 'route-detail-top');
    const copy = node('div');
    copy.append(node('h2', '', routeTitle(route)), node('p', '', `${MODE_NAMES[modeOf(route.mode)]} · напрямок з OpenStreetMap`));
    heading.append(routeNumber(route), copy);
    const stops = Array.isArray(route.stops) ? route.stops.filter(validPosition) : [];
    const metadata = node('div', 'route-meta');
    metadata.append(node('span', '', `${stops.length} позначок зупинок`), node('span', '', '© OpenStreetMap'));
    const note = node('p', 'route-note', 'Платформа й зупинка можуть мати окремі позначки. GPS відфільтровано за номером і, коли доступно, типом транспорту; напрямок руху GPS не визначено. Зворотний напрямок оберіть окремо в каталозі.');
    const list = node('ol', 'route-stops');
    for (const stop of stops) {
      const item = node('li', 'route-stop');
      item.append(button(clean(stop.name || 'Зупинка'), '', () => showStop(stop, false)));
      list.append(item);
    }
    if (!stops.length) list.append(node('p', 'field-note', 'Зупинки з координатами не внесено до цього напрямку.'));
    $('route-detail').replaceChildren(back, heading, metadata, note, list);
  }
  function stopPopup(stop) {
    const box = node('div', 'map-popup');
    box.append(node('h3', '', clean(stop.name || 'Зупинка')), node('p', '', 'Зупинка · OpenStreetMap'));
    if (Number.isFinite(stop.distance)) box.append(node('p', '', `${Math.round(stop.distance)} м від обраної точки`));
    const saved = state.favorites.some((item) => item.id === stop.id);
    box.append(button(saved ? '★ Прибрати з обраного' : '☆ Зберегти зупинку', 'button button-primary', (event) => {
      if (toggleFavorite(stop)) {
        event.currentTarget.textContent = state.favorites.some((item) => item.id === stop.id) ? '★ Прибрати з обраного' : '☆ Зберегти зупинку';
      }
    }));
    box.append(node('p', '', 'Обране зберігається на цьому пристрої.'));
    return box;
  }
  function makeStopMarker(stop, layer) {
    const content = node('div', 'stop-marker');
    const marker = L.marker([stop.lat, stop.lon], {
      icon: L.divIcon({ html: content, className: 'stop-icon', iconSize: [13, 13], iconAnchor: [6, 6], popupAnchor: [0, -9] }),
      title: clean(stop.name || 'Зупинка'), keyboard: true,
    }).bindPopup(stopPopup(stop), { maxWidth: 260, autoPanPaddingTopLeft: [15, 100], autoPanPaddingBottomRight: [15, 190] });
    marker.on('popupopen', () => { marker.setPopupContent(stopPopup(stop)); });
    return marker.addTo(layer);
  }
  function showStop(stop, collapse = true) {
    state.activeStop = stop;
    if (collapse) setExpanded(false);
    state.placeLayer.clearLayers();
    const marker = makeStopMarker(stop, state.placeLayer);
    focusPosition(stop, 17);
    marker.openPopup();
  }
  function stopCard(stop) {
    const card = button('', 'result-card', () => showStop(stop));
    const pin = node('span', 'result-pin'); pin.append(pinIcon());
    const copy = node('span', 'result-copy');
    copy.append(node('strong', '', clean(stop.name || 'Зупинка')),
      node('p', '', `${MODE_NAMES[modeOf(stop.mode)]}${Number.isFinite(stop.distance) ? ` · ${Math.round(stop.distance)} м` : ''}`));
    card.append(pin, copy, node('span', 'result-arrow', '›'));
    return card;
  }
  async function nearbyStops(position) {
    if (!state.token || !validPosition(position)) return;
    clearRoute();
    const sequence = ++state.nearbySequence;
    switchTab('map-panel');
    loading($('nearby-results'), 'Шукаємо зупинки поруч…');
    $('nearby').disabled = true;
    try {
      const result = await api(`/api/stops?${new URLSearchParams({ lat: String(position.lat), lon: String(position.lon) })}`);
      if (sequence !== state.nearbySequence) return;
      const stops = Array.isArray(result.stops) ? result.stops.filter(validPosition).slice(0, 50) : [];
      state.stopsLayer.clearLayers();
      if (!stops.length) {
        empty($('nearby-results'), 'Зупинок поруч не знайдено', 'Посуньте карту або оберіть інше місце. Дані OpenStreetMap можуть бути неповними.');
        return;
      }
      const heading = node('div', 'list-heading'); heading.append(node('span', '', `Зупинки поруч · ${stops.length}`), node('span', '', 'OpenStreetMap'));
      const fragment = document.createDocumentFragment(); fragment.append(heading);
      for (const stop of stops) { makeStopMarker(stop, state.stopsLayer); fragment.append(stopCard(stop)); }
      $('nearby-results').replaceChildren(fragment);
      fitPoints(state.stopsLayer.getBounds(), 16);
    } catch {
      if (sequence === state.nearbySequence) empty($('nearby-results'), 'Не вдалося завантажити зупинки', 'Картографічне джерело тимчасово недоступне.', () => nearbyStops(position));
    } finally { if (sequence === state.nearbySequence) $('nearby').disabled = false; }
  }
  async function searchPlaces(event) {
    event.preventDefault();
    const entered = $('place-query').value.trim();
    if (entered.length < 2) { toast('Введіть щонайменше два символи.'); return; }
    const query = /,|київ/iu.test(entered) ? entered : `${entered}, Київ`;
    const sequence = ++state.searchSequence;
    loading($('search-results'), 'Шукаємо місце…');
    $('search-submit').disabled = true;
    try {
      const result = await api(`/api/search?${new URLSearchParams({ q: query })}`);
      if (sequence !== state.searchSequence) return;
      const places = Array.isArray(result.places) ? result.places.filter(validPosition).slice(0, 12) : [];
      if (!places.length) { empty($('search-results'), 'Місце не знайдено', 'Уточніть назву та місто, наприклад «вокзал, Полтава».'); return; }
      const fragment = document.createDocumentFragment();
      for (const place of places) {
        const card = button('', 'result-card', () => {
          clearRoute(); state.placeLayer.clearLayers();
          const marker = L.marker([place.lat, place.lon], {
            icon: L.divIcon({ html: node('div', 'place-marker'), className: 'stop-icon', iconSize: [23, 23], iconAnchor: [11, 11] }), title: clean(place.name),
          }).addTo(state.placeLayer);
          marker.bindPopup(node('strong', '', clean(place.name, 200)));
          focusPosition(place, 16);
          nearbyStops(place);
        });
        const pin = node('span', 'result-pin'); pin.append(pinIcon());
        const copy = node('span', 'result-copy'); copy.append(node('strong', '', clean(place.name, 240)), node('p', '', 'Показати місце й зупинки поруч'));
        card.append(pin, copy, node('span', 'result-arrow', '›')); fragment.append(card);
      }
      $('search-results').replaceChildren(fragment);
    } catch {
      if (sequence === state.searchSequence) empty($('search-results'), 'Пошук тимчасово недоступний', 'Спробуйте ще раз або знайдіть місце на карті.', () => $('place-search').requestSubmit());
    } finally { if (sequence === state.searchSequence) $('search-submit').disabled = false; }
  }
  function readFavorites() {
    try {
      const saved = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
      state.favorites = Array.isArray(saved) ? saved.filter((stop) => validPosition(stop) && typeof stop.id === 'string').slice(0, 30) : [];
    } catch { state.favorites = []; }
  }
  function saveFavorites(next) {
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)); }
    catch { toast('Браузер не дозволив зберегти обране на цьому пристрої.'); return false; }
    state.favorites = next;
    renderFavorites();
    return true;
  }
  function toggleFavorite(stop) {
    if (!validPosition(stop) || !stop.id) return false;
    const exists = state.favorites.some((item) => item.id === stop.id);
    if (!exists && state.favorites.length >= 30) { toast('В обраному вже 30 зупинок. Спочатку приберіть зайву.'); return false; }
    const next = exists ? state.favorites.filter((item) => item.id !== stop.id) : [...state.favorites, {
      id: clean(stop.id, 120), name: clean(stop.name || 'Зупинка'), lat: stop.lat, lon: stop.lon, mode: modeOf(stop.mode),
    }];
    const success = saveFavorites(next);
    if (success) toast(exists ? 'Зупинку прибрано з обраного' : 'Зупинку збережено на цьому пристрої');
    return success;
  }
  function renderFavorites() {
    $('clear-favorites').hidden = !state.favorites.length;
    if (!state.favorites.length) {
      empty($('favorites-results'), 'Ваші зупинки будуть тут', 'Натисніть зупинку на карті та збережіть її. Обране доступне лише на цьому пристрої.');
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const stop of state.favorites) {
      const row = node('div', 'favorite-row');
      const remove = button('×', 'remove-favorite', () => toggleFavorite(stop));
      remove.setAttribute('aria-label', `Прибрати з обраного: ${clean(stop.name)}`);
      row.append(stopCard(stop), remove); fragment.append(row);
    }
    $('favorites-results').replaceChildren(fragment);
  }
  function locate() {
    if (!navigator.geolocation) { toast('Цей браузер не підтримує геолокацію. Знайдіть місце через пошук.'); return; }
    $('locate').disabled = true;
    navigator.geolocation.getCurrentPosition((position) => {
      $('locate').disabled = false;
      const point = { lat: position.coords.latitude, lon: position.coords.longitude };
      if (!validPosition(point)) { toast('Не вдалося визначити координати.'); return; }
      state.locationLayer.clearLayers();
      if (Number.isFinite(position.coords.accuracy)) L.circle([point.lat, point.lon], {
        radius: Math.min(position.coords.accuracy, 2000), color: '#438deb', weight: 1, fillOpacity: .07, interactive: false,
      }).addTo(state.locationLayer);
      L.marker([point.lat, point.lon], { icon: L.divIcon({ html: node('div', 'my-position'), className: 'stop-icon', iconSize: [17, 17], iconAnchor: [8, 8] }), title: 'Ваше місце' }).addTo(state.locationLayer);
      setExpanded(false); focusPosition(point, 16);
      toast('Місце знайдено. Відкрийте «Карта», щоб знайти зупинки поруч.');
    }, () => { $('locate').disabled = false; toast('Місце недоступне. Дозвольте геолокацію або скористайтеся пошуком.'); }, { enableHighAccuracy: false, timeout: 15_000, maximumAge: 30_000 });
  }
  function bindInterface() {
    $('sheet-toggle').addEventListener('click', () => setExpanded($('sheet').classList.contains('is-collapsed')));
    for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    $('refresh').addEventListener('click', () => refreshLive(true));
    $('locate').addEventListener('click', locate);
    $('nearby').addEventListener('click', () => {
      const center = state.map.getCenter(); nearbyStops({ lat: center.lat, lon: center.lng });
    });
    $('place-search').addEventListener('submit', searchPlaces);
    $('route-query').addEventListener('input', () => { if (state.routes) renderRoutes(); });
    for (const chip of document.querySelectorAll('.mode-chip')) chip.addEventListener('click', () => {
      state.mode = chip.dataset.mode;
      for (const item of document.querySelectorAll('.mode-chip')) {
        const selected = item === chip; item.classList.toggle('is-active', selected); item.setAttribute('aria-pressed', String(selected));
      }
      if (state.routes) renderRoutes();
    });
    $('clear-route').addEventListener('click', () => clearRoute());
    $('open-route-detail').addEventListener('click', () => switchTab('routes-panel'));
    $('home').addEventListener('click', (event) => {
      event.preventDefault(); clearRoute(); state.stopsLayer.clearLayers(); state.placeLayer.clearLayers();
      state.nearbySequence++; $('nearby').disabled = false;
      switchTab('map-panel', false); fitPoints(L.latLngBounds(KYIV_BOUNDS), 12);
    });
    $('clear-favorites').addEventListener('click', () => { if (saveFavorites([])) toast('Обране на цьому пристрої очищено'); });
    $('about-button').addEventListener('click', () => $('about-dialog').showModal());
    $('close-about').addEventListener('click', () => $('about-dialog').close());
    $('close-about-bottom').addEventListener('click', () => $('about-dialog').close());
    $('about-dialog').addEventListener('click', (event) => { if (event.target === $('about-dialog')) $('about-dialog').close(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.token) { renderVehicles(); refreshLive(); } });
    window.addEventListener('resize', () => { state.map?.invalidateSize(); });
  }
  async function boot() {
    state.tg = window.Telegram?.WebApp;
    try {
      state.tg?.ready(); state.tg?.expand();
      state.tg?.setHeaderColor?.('#101c35'); state.tg?.setBackgroundColor?.('#101c35');
      state.tg?.onEvent?.('safeAreaChanged', applySafeArea);
      state.tg?.onEvent?.('contentSafeAreaChanged', applySafeArea);
    } catch { /* Older Telegram clients still work as ordinary web views. */ }
    applySafeArea();
    if (previewKey || state.tg?.initData) $('auth-status').textContent = 'Перевіряємо доступ…';
    try {
      if (!await authenticate()) return;
    } catch (error) {
      clearSession();
      showWelcome(error.status === 0 ? 'Не вдалося зв’язатися з ботом. Перевірте інтернет і відкрийте карту ще раз.'
        : 'Для цієї карти потрібне запрошення. Відкрийте приватний бот і скористайтеся кнопкою карти.');
      return;
    }
    if (!window.L) { showWelcome('Картографічний модуль не завантажився. Перевірте інтернет і відкрийте карту ще раз.'); return; }
    $('welcome').hidden = true;
    $('application').hidden = false;
    readFavorites();
    initializeMap();
    bindInterface();
    await refreshLive();
    setInterval(() => { if (!document.hidden && state.token) refreshLive(); }, 20_000);
    setInterval(() => { if (state.token) renderVehicles(); }, 5000);
  }
  document.addEventListener('DOMContentLoaded', boot, { once: true });
})();

/* Mappi Mini App. No GPS interpolation, ETA estimates, or background geolocation. */
(() => {
  'use strict';

  // Runs before the third-party Telegram SDK. Preview credentials leave the URL
  // immediately and stay only in this closure until the authentication request.
  const initialFragment = new URLSearchParams(location.hash.slice(1));
  let previewKey = initialFragment.get('preview');
  let requestedPanel = initialFragment.get('panel');
  if (previewKey !== null) history.replaceState(null, '', location.pathname + location.search);

  const SESSION_KEY = 'mappi.session.v1';
  const FAVORITES_KEY = 'mappi.favorites.v2';
  const OLD_FAVORITES_KEY = 'mappi.savedStops.v1';
  const SETTINGS_KEY = 'mappi.mapSettings.v1';
  const MAX_AGE_MS = 180_000;
  const KYIV_BOUNDS = [[50.335, 30.345], [50.585, 30.705]];
  const SOURCE_URL = 'https://data.kyivcity.gov.ua/dataset/dani-pro-mistseznakhodzhennia-miskoho-elektrychnoho-ta-pasazhyrskoho-avtomobilnoho-tra-dep-transport';
  const MODE_NAMES = { bus: 'Автобус', trolleybus: 'Тролейбус', tram: 'Трамвай', subway: 'Метро', light_rail: 'Легкорейковий', train: 'Поїзд', unknown: 'Інший тип' };
  const MODE_COLORS = { bus: '#16aaa4', trolleybus: '#477fc0', tram: '#9465bf', subway: '#dc7e46', light_rail: '#9b6fb1', unknown: '#537c97' };
  const state = {
    token: null, map: null, tg: null, activeTab: 'map-panel', vehicles: [], markers: new Map(),
    liveBusy: false, liveFailed: false, fetchedAt: null, routes: null, routesBusy: false,
    catalogMode: 'all', selectedRoute: null, routeSequence: 0, nearbySequence: 0, searchSequence: 0,
    favorites: [], favoriteRoutes: [], favoriteTab: 'stops', stopsLayer: null, placeLayer: null, locationLayer: null,
    activeRoutes: new Map(), routeReturnTab: 'routes-panel', routePromise: null, panels: new Map(),
    settings: { gps: true, stops: true, lines: true, modes: Object.keys(MODE_NAMES) },
    stopRouteCache: new Map(), stopRoutePending: new Map(),
    activeStop: null, selectedPoint: null, openPopup: null, toastTimer: null,
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
    constructor(status) {
      const messages = {
        0: 'Не вдалося отримати відповідь. Перевірте інтернет і спробуйте ще раз.',
        400: 'Перевірте введені дані й спробуйте ще раз.',
        401: 'Сеанс завершився. Відкрийте карту знову через Telegram-бота.',
        403: 'Немає доступу. Відкрийте карту через приватного Telegram-бота.',
        404: 'Ці дані не знайдено. Спробуйте інший маршрут або місце.',
        413: 'Запит завеликий. Спробуйте меншу ділянку карти.',
        422: 'Не вдалося обробити ці дані. Спробуйте інші точки або маршрут.',
        429: 'Забагато запитів. Зачекайте трохи й спробуйте ще раз.',
        502: 'Джерело тимчасово недоступне. Спробуйте пізніше.',
        503: 'Сервіс тимчасово недоступний. Спробуйте пізніше.',
        504: 'Джерело відповідає надто довго. Спробуйте ще раз.',
      };
      super(messages[status] || 'Не вдалося завантажити дані. Спробуйте ще раз трохи пізніше.');
      this.name = 'ApiError';
      this.status = status;
    }
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
    if (typeof path !== 'string' || !path.startsWith('/api/') || path.startsWith('//')) throw new ApiError(400);
    const headers = { Accept: 'application/json' };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    if (options.body) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(path, {
        method: options.method || 'GET', headers,
        ...(options.body ? { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(Math.max(1000, Math.min(90_000, Number(options.timeoutMs) || 25_000))), cache: 'no-store', redirect: 'error',
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
    updatePopupLayout(state.openPopup);
  }
  function setExpanded(expanded) {
    if (expanded) state.map?.closePopup();
    $('sheet').classList.toggle('is-collapsed', !expanded);
    $('sheet-toggle').setAttribute('aria-expanded', String(expanded));
    $('sheet-toggle').setAttribute('aria-label', expanded ? 'Згорнути панель' : 'Розгорнути панель');
  }
  function switchTab(id, expand = true) {
    if (!$(id)) return false;
    if (id !== 'routes-panel' && id !== state.activeTab) state.routeSequence++;
    state.activeTab = id;
    for (const tab of document.querySelectorAll('.tab')) {
      const selected = tab.dataset.tab === id;
      tab.classList.toggle('is-active', selected);
      if (selected) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
    }
    for (const panel of document.querySelectorAll('.panel')) panel.hidden = panel.id !== id;
    const headings = {
      'map-panel': ['КИЇВ · ЗАРАЗ', 'Транспорт на карті'], 'routes-panel': ['КИЇВ · МАРШРУТИ', 'Оберіть свій маршрут'],
      'search-panel': ['УКРАЇНА · ПОШУК', 'Знайдіть місце'], 'favorites-panel': ['НА ЦЬОМУ ПРИСТРОЇ', 'Ваше обране'],
    };
    const registered = state.panels.get(id);
    const heading = headings[id] || [registered?.kicker || 'MAPPI', registered?.title || registered?.label || 'Карта'];
    $('sheet-kicker').textContent = heading[0];
    $('sheet-title').textContent = heading[1];
    setExpanded(expand);
    if (id === 'routes-panel' && !state.routes) loadRoutes();
    if (id === 'favorites-panel') renderFavorites();
    if (registered?.onOpen) Promise.resolve().then(() => registered.onOpen()).catch(() => toast('Не вдалося відкрити розділ. Спробуйте ще раз.'));
    window.dispatchEvent(new CustomEvent('mappi:panel-change', { detail: { id } }));
    return true;
  }
  function registerPanel({ id, label, title, kicker, content, onOpen }) {
    if (!/^[a-z][a-z0-9-]{1,60}$/.test(id) || state.panels.has(id) || $(id) || !(content instanceof Node)) return false;
    const panel = node('section', 'panel');
    panel.id = id; panel.hidden = true; panel.setAttribute('aria-label', clean(title || label));
    panel.append(content);
    document.querySelector('.sheet-content').append(panel);
    const tab = button('', 'tab', () => switchTab(id));
    tab.dataset.tab = id;
    const symbol = node('span', 'tab-symbol', id.includes('schedule') ? '◷' : '⇄');
    symbol.setAttribute('aria-hidden', 'true');
    tab.append(symbol, node('span', '', clean(label, 22)));
    document.querySelector('.tabbar').append(tab);
    state.panels.set(id, { label, title, kicker, onOpen });
    document.documentElement.style.setProperty('--tab-count', String(document.querySelectorAll('.tab').length));
    if (requestedPanel === id) { requestedPanel = null; queueMicrotask(() => switchTab(id)); }
    return true;
  }
  function publishBridge() {
    window.Mappi = Object.freeze({
      api, map: state.map, registerPanel,
      showPanel: (id) => switchTab(id),
      fitBounds: (bounds) => fitPoints(bounds?.isValid ? bounds : L.latLngBounds(bounds)),
      focusMap: (bounds) => {
        setExpanded(false);
        fitPoints(bounds?.isValid ? bounds : L.latLngBounds(bounds));
      },
      showStop,
      clearMap: () => {
        clearRoute();
        state.nearbySequence++; $('nearby').disabled = false;
        state.stopsLayer.clearLayers(); state.placeLayer.clearLayers();
      },
      getSelectedPoint: () => {
        const point = state.selectedPoint || state.activeStop;
        if (point) return { name: clean(point.name || 'Обрана точка'), lat: point.lat, lon: point.lon };
        const center = state.map.getCenter();
        return { name: 'Центр карти', lat: center.lat, lon: center.lng };
      },
    });
    window.dispatchEvent(new CustomEvent('mappi:ready', { detail: window.Mappi }));
  }
  function planPoint(kind, point) {
    if (!validPosition(point)) return;
    state.selectedPoint = { name: clean(point.name || 'Точка на карті'), lat: point.lat, lon: point.lon };
    state.map.closePopup();
    window.dispatchEvent(new CustomEvent('mappi:plan-point', { detail: { kind, point: { ...state.selectedPoint } } }));
  }
  function pointActions(point) {
    const actions = node('div', 'point-actions');
    actions.append(button('A · Звідси', 'button button-secondary', () => planPoint('from', point)),
      button('B · Сюди', 'button button-secondary', () => planPoint('to', point)));
    return actions;
  }
  function pointPopup(point) {
    const box = node('div', 'map-popup');
    box.append(node('h3', '', clean(point.name || 'Точка на карті')), pointActions(point));
    return box;
  }
  function readSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (!saved || typeof saved !== 'object') return;
      for (const key of ['gps', 'lines', 'stops']) if (typeof saved[key] === 'boolean') state.settings[key] = saved[key];
      if (Array.isArray(saved.modes)) state.settings.modes = [...new Set(saved.modes.filter((mode) => Object.hasOwn(MODE_NAMES, mode)))];
    } catch { /* Defaults still allow the map to work. */ }
  }
  function persistSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); }
    catch { toast('Налаштування працюють у цьому сеансі; браузер не дозволив їх зберегти.'); }
  }
  function setLayerVisible(layer, visible) {
    if (!layer || !state.map) return;
    if (visible && !state.map.hasLayer(layer)) layer.addTo(state.map);
    if (!visible && state.map.hasLayer(layer)) state.map.removeLayer(layer);
  }
  function applyMapSettings() {
    for (const key of ['gps', 'lines', 'stops']) $( `toggle-${key}` ).checked = state.settings[key];
    setLayerVisible(state.stopsLayer, state.settings.stops);
    for (const entry of state.activeRoutes.values()) {
      setLayerVisible(entry.lines, state.settings.lines);
      setLayerVisible(entry.stops, state.settings.stops);
    }
    renderMapModeFilters();
    renderVehicles();
  }
  function renderMapModeFilters() {
    const fragment = document.createDocumentFragment();
    for (const [mode, name] of Object.entries(MODE_NAMES)) {
      if (mode === 'train') continue;
      const active = state.settings.modes.includes(mode);
      const chip = button(name, `map-mode-chip mode-${mode}${active ? ' is-active' : ''}`, () => {
        state.settings.modes = active ? state.settings.modes.filter((item) => item !== mode) : [...state.settings.modes, mode];
        persistSettings(); applyMapSettings();
      });
      chip.setAttribute('aria-pressed', String(active));
      fragment.append(chip);
    }
    $('map-mode-filters').replaceChildren(fragment);
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
  function popupOptions() {
    const rect = $('map').getBoundingClientRect();
    const header = document.querySelector('.topbar').getBoundingClientRect();
    const routeChip = $('route-map-label');
    const sheet = $('sheet').getBoundingClientRect();
    const desktop = window.innerWidth >= 650;
    const left = desktop ? Math.ceil(sheet.right - rect.left + 15) : 15;
    const top = Math.ceil(Math.max(170, header.bottom - rect.top + 102,
      routeChip.hidden ? 0 : routeChip.getBoundingClientRect().bottom - rect.top + 12));
    const bottom = desktop ? 20 : Math.ceil(Math.max(20, rect.bottom - sheet.top + 20));
    return {
      autoPan: true,
      autoPanPaddingTopLeft: [left, top],
      autoPanPaddingBottomRight: [65, bottom],
      maxWidth: Math.max(80, Math.min(260, rect.width - left - 65 - 34)),
      // Leaflet adds content margins, the wrapper and a tip outside maxHeight.
      // Constrain the entire card, including actions and asynchronously added routes.
      maxHeight: Math.max(40, Math.min(360, rect.height - top - bottom - 56)),
    };
  }
  function updatePopupLayout(popup) {
    if (!popup?.isOpen()) return;
    Object.assign(popup.options, popupOptions());
    popup.getElement()?.style.setProperty('--mappi-popup-min-width', `${Math.min(205, popup.options.maxWidth)}px`);
    popup.update();
  }
  function initializeMap() {
    // Feature panels also create Leaflet popups, so they share these defaults.
    L.Popup.mergeOptions({ maxWidth: 260, maxHeight: 360, autoPanPaddingTopLeft: [15, 170], autoPanPaddingBottomRight: [65, 190] });
    state.map = L.map('map', { zoomControl: false, attributionControl: false, minZoom: 5, maxZoom: 19, preferCanvas: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
      updateWhenIdle: true, keepBuffer: 2,
    }).addTo(state.map);
    L.control.attribution({ prefix: false, position: 'bottomright' }).addTo(state.map);
    state.stopsLayer = L.featureGroup().addTo(state.map);
    state.placeLayer = L.featureGroup().addTo(state.map);
    state.locationLayer = L.featureGroup().addTo(state.map);
    fitPoints(L.latLngBounds(KYIV_BOUNDS), 12);
    new ResizeObserver(() => {
      document.documentElement.style.setProperty('--sheet-size', `${Math.round($('sheet').getBoundingClientRect().height)}px`);
    }).observe($('sheet'));
    state.map.on('popupopen', ({ popup }) => {
      setExpanded(false);
      state.openPopup = popup;
      updatePopupLayout(popup);
      updateAges();
    });
    state.map.on('popupclose', ({ popup }) => { if (state.openPopup === popup) state.openPopup = null; });
    state.map.on('click', (event) => {
      const point = { name: 'Точка на карті', lat: event.latlng.lat, lon: event.latlng.lng };
      state.selectedPoint = point;
      L.popup(popupOptions()).setLatLng(event.latlng).setContent(pointPopup(point)).openOn(state.map);
    });
    $('zoom-in').addEventListener('click', () => state.map.zoomIn());
    $('zoom-out').addEventListener('click', () => state.map.zoomOut());
    applyMapSettings();
  }
  function vehicleMatches(vehicle) {
    if (!state.settings.gps || !state.settings.modes.includes(modeOf(vehicle.mode))) return false;
    if (!state.activeRoutes.size) return true;
    return [...state.activeRoutes.values()].some(({ route }) => {
      if (!route.ref || vehicle.routeIsPublicNumber !== true || normalizeRef(vehicle.route) !== normalizeRef(route.ref)) return false;
      const routeMode = modeOf(route.mode);
      const vehicleMode = modeOf(vehicle.mode);
      return routeMode === 'unknown' || vehicleMode === 'unknown' || routeMode === vehicleMode;
    });
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
    box.append(button('Показати маршрут', 'button button-primary', () => chooseVehicleRoute(vehicle)));
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
        marker.bindPopup(vehiclePopup(vehicle));
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
    const routePrefix = state.activeRoutes.size > 1 ? `${state.activeRoutes.size} маршрути · `
      : state.selectedRoute ? `${state.selectedRoute.ref ? `№ ${clean(state.selectedRoute.ref, 12)}` : 'Маршрут'} · ` : '';
    $('live-status').textContent = !state.settings.gps ? 'GPS вимкнено'
      : state.liveFailed
      ? `${routePrefix}GPS недоступний${count ? ` · ${count} актуальних` : ''}`
      : count ? `${routePrefix}${count} GPS-позицій${state.selectedRoute ? '' : ' · Київ'}`
      : state.vehicles.length ? `${routePrefix}За фільтрами машин немає` : `${routePrefix}Свіжих GPS-позицій немає`;
    $('connection-dot').classList.remove('is-loading');
    $('connection-dot').classList.toggle('is-offline', state.liveFailed || count === 0);
    $('live-count').textContent = !state.settings.gps ? 'GPS вимкнено' : count ? `${count} машин на карті` : state.vehicles.length ? 'За поточними фільтрами машин немає' : 'Свіжих позицій поки немає';
    $('live-updated').textContent = !state.settings.gps ? 'Увімкніть шар GPS, щоб бачити транспорт' : state.liveFailed ? 'Спробуйте кнопку оновлення на карті'
      : state.fetchedAt ? `Знімок отримано о ${clock(state.fetchedAt)} · до 3 хв` : 'Джерело охоплює лише частину транспорту';
    if (state.activeTab === 'map-panel') $('sheet-kicker').textContent = `КИЇВ · ${count} GPS-ПОЗИЦІЙ`;
    updateAges();
  }
  async function refreshLive(manual = false) {
    if (!state.settings.gps) { if (manual) toast('Увімкніть GPS у розділі «Карта».'); return; }
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
    if (!state.token) return null;
    if (state.routes) return state.routes;
    if (state.routePromise) return state.routePromise;
    state.routesBusy = true;
    loading($('routes-results'), 'Завантажуємо маршрути Києва…');
    state.routePromise = (async () => {
      try {
        const result = await api('/api/routes', { timeoutMs: 40_000 });
        state.routes = Array.isArray(result.routes) ? result.routes.slice(0, 2500) : [];
        renderRoutes();
        if (state.selectedRoute && $('route-detail').dataset.routeId === state.selectedRoute.id) renderRouteDetail(state.selectedRoute);
        return state.routes;
      } catch {
        empty($('routes-results'), 'Маршрути зараз недоступні', 'Не вдалося отримати каталог OpenStreetMap. Карта й GPS працюють окремо.', loadRoutes);
        return null;
      } finally { state.routesBusy = false; state.routePromise = null; }
    })();
    return state.routePromise;
  }
  function makeRouteCard(route, action = () => selectRoute(route)) {
    const card = button('', 'result-card', action);
    const copy = node('span', 'result-copy');
    copy.append(node('strong', '', routeTitle(route)), node('p', '', `${MODE_NAMES[modeOf(route.mode)]}${route.operator ? ` · ${clean(route.operator, 65)}` : ''}`));
    card.append(routeNumber(route), copy, node('span', 'result-arrow', '›'));
    return card;
  }
  function renderRoutes() {
    const query = $('route-query').value.trim().toLocaleLowerCase('uk-UA');
    const matches = (state.routes ?? []).filter((route) => {
      if (state.catalogMode !== 'all' && modeOf(route.mode) !== state.catalogMode) return false;
      return !query || [route.ref, route.name, route.from, route.to].some((value) => clean(value, 300).toLocaleLowerCase('uk-UA').includes(query));
    });
    $('routes-count').textContent = `Напрямків: ${matches.length}`;
    if (!matches.length) {
      empty($('routes-results'), 'Маршрут не знайдено', query ? 'Спробуйте інший номер або тип транспорту. В OpenStreetMap можуть бути не всі маршрути.' : 'Для цього типу транспорту в каталозі немає маршрутів.');
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const route of matches) {
      const row = node('div', `route-catalog-row${state.activeRoutes.has(route.id) ? ' is-selected' : ''}`);
      const saved = state.favoriteRoutes.some((item) => item.id === route.id);
      const favorite = button(saved ? '★' : '☆', `favorite-route-button${saved ? ' is-saved' : ''}`, () => toggleFavoriteRoute(route));
      favorite.setAttribute('aria-label', `${saved ? 'Прибрати' : 'Зберегти'} маршрут ${clean(route.ref)} ${routeTitle(route)}`);
      const active = state.activeRoutes.has(route.id);
      const overlay = button(active ? '✓' : '+', `route-overlay-button${active ? ' is-active' : ''}`, () => active ? removeRoute(route.id) : selectRoute(route));
      overlay.setAttribute('aria-label', `${active ? 'Прибрати з карти' : 'Додати на карту'} маршрут ${clean(route.ref)} ${routeTitle(route)}`);
      overlay.setAttribute('aria-pressed', String(active));
      row.append(makeRouteCard(route), favorite, overlay);
      fragment.append(row);
    }
    $('routes-results').replaceChildren(fragment);
  }
  function clearRoute(showCatalog = true) {
    window.dispatchEvent(new CustomEvent('mappi:map-reset'));
    state.routeSequence++;
    state.selectedRoute = null;
    for (const entry of state.activeRoutes.values()) { state.map.removeLayer(entry.lines); state.map.removeLayer(entry.stops); }
    state.activeRoutes.clear();
    $('route-map-label').hidden = true;
    if (showCatalog) { $('route-detail').hidden = true; $('route-catalog').hidden = false; }
    renderActiveRoutes();
    if (state.routes) renderRoutes();
    renderVehicles();
  }
  function backFromRoute() {
    state.routeSequence++;
    $('route-detail').hidden = true;
    $('route-catalog').hidden = false;
    switchTab(state.routeReturnTab === 'favorites-panel' ? 'favorites-panel' : 'routes-panel');
  }
  function removeRoute(id) {
    const entry = state.activeRoutes.get(id);
    if (!entry) return;
    state.map.removeLayer(entry.lines); state.map.removeLayer(entry.stops);
    state.activeRoutes.delete(id);
    if (state.selectedRoute?.id === id) {
      state.routeSequence++;
      const next = [...state.activeRoutes.values()].at(-1);
      state.selectedRoute = next?.route || null;
      if (next) focusRoute(next.route.id, false);
      else { $('route-map-label').hidden = true; $('route-detail').hidden = true; $('route-catalog').hidden = false; }
    }
    renderActiveRoutes(); renderVehicles();
    if (state.routes) renderRoutes();
  }
  function renderActiveRoutes() {
    $('active-routes').hidden = !state.activeRoutes.size;
    const fragment = document.createDocumentFragment();
    const heading = node('div', 'list-heading');
    heading.append(node('span', '', `На карті: ${state.activeRoutes.size} / 4`), button('Прибрати всі', 'text-button', () => clearRoute()));
    fragment.append(heading);
    for (const { route } of state.activeRoutes.values()) {
      const row = node('div', 'active-route-row');
      const focus = button('', `active-route-focus${state.selectedRoute?.id === route.id ? ' is-active' : ''}`, () => {
        switchTab('routes-panel'); focusRoute(route.id);
      });
      focus.append(routeNumber(route), node('span', '', routeTitle(route)));
      const remove = button('×', 'remove-favorite', () => removeRoute(route.id));
      remove.setAttribute('aria-label', `Прибрати з карти маршрут ${clean(route.ref)} ${routeTitle(route)}`);
      row.append(focus, remove); fragment.append(row);
    }
    $('active-routes').replaceChildren(fragment);
  }
  function focusRoute(id, fit = true) {
    const entry = state.activeRoutes.get(id);
    if (!entry) return;
    state.selectedRoute = entry.route;
    $('route-map-ref').textContent = clean(entry.route.ref || '—', 15);
    $('route-map-ref').className = `route-number mode-${modeOf(entry.route.mode)}`;
    $('route-map-name').textContent = routeTitle(entry.route);
    $('route-map-label').hidden = false;
    $('route-catalog').hidden = true; $('route-detail').hidden = false;
    renderRouteDetail(entry.route);
    renderActiveRoutes(); renderVehicles();
    if (fit) {
      if (window.innerWidth < 650) setExpanded(false);
      if (entry.bounds.isValid()) fitPoints(entry.bounds, 15);
    }
  }
  async function selectRoute(route, options = {}) {
    if (!route?.id) return;
    state.routeReturnTab = options.returnTab || (state.activeTab === 'favorites-panel' ? 'favorites-panel' : 'routes-panel');
    if (state.activeRoutes.has(route.id)) {
      if (options.replaceId && options.replaceId !== route.id) removeRoute(options.replaceId);
      switchTab('routes-panel'); focusRoute(route.id); return;
    }
    if (state.activeRoutes.size >= 4 && !state.activeRoutes.has(options.replaceId)) {
      toast('На карті вже 4 маршрути. Приберіть один зі списку в розділі «Карта».');
      switchTab('map-panel'); return;
    }
    state.nearbySequence++;
    $('nearby').disabled = false;
    const sequence = ++state.routeSequence;
    switchTab('routes-panel');
    $('route-catalog').hidden = true;
    $('route-detail').hidden = false;
    delete $('route-detail').dataset.routeId;
    const back = button('← Назад до списку', 'route-detail-back', backFromRoute);
    const loadingBox = node('div');
    loading(loadingBox, `Завантажуємо маршрут ${clean(route.ref, 15)}…`);
    $('route-detail').replaceChildren(back, loadingBox);
    try {
      const detail = await api(`/api/route?${new URLSearchParams({ id: route.id })}`, { timeoutMs: 65_000 });
      if (sequence !== state.routeSequence) return;
      if (options.replaceId) removeRoute(options.replaceId);
      state.stopsLayer.clearLayers();
      state.placeLayer.clearLayers();
      const color = MODE_COLORS[modeOf(detail.mode)] || MODE_COLORS.unknown;
      const lines = L.featureGroup();
      const stops = L.featureGroup();
      for (const line of Array.isArray(detail.lines) ? detail.lines : []) {
        if (!Array.isArray(line) || line.length < 2 || !line.every((point) => Array.isArray(point) && validPosition({ lat: point[0], lon: point[1] }))) continue;
        L.polyline(line, { color: '#ffffff', weight: 8, opacity: .9, interactive: false }).addTo(lines);
        L.polyline(line, { color, weight: 4.5, opacity: .92, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(lines);
      }
      for (const stop of (detail.stops ?? []).filter(validPosition)) makeStopMarker({ ...stop, mode: detail.mode }, stops);
      const bounds = lines.getBounds();
      if (stops.getBounds().isValid()) bounds.extend(stops.getBounds());
      state.activeRoutes.set(detail.id, { route: detail, lines, stops, bounds });
      applyMapSettings();
      if (state.routes) renderRoutes();
      focusRoute(detail.id);
    } catch (error) {
      if (sequence !== state.routeSequence) return;
      empty(loadingBox, 'Не вдалося відкрити маршрут', error.status === 404 ? 'Цей напрямок більше не доступний у каталозі.' : 'Джерело маршруту тимчасово недоступне.', () => selectRoute(route, options));
    }
  }
  function renderRouteDetail(route) {
    $('route-detail').dataset.routeId = route.id;
    const back = button(state.routeReturnTab === 'favorites-panel' ? '← До обраного' : '← Усі маршрути', 'route-detail-back', backFromRoute);
    const heading = node('div', 'route-detail-top');
    const copy = node('div');
    copy.append(node('h2', '', routeTitle(route)), node('p', '', `${MODE_NAMES[modeOf(route.mode)]} · напрямок з OpenStreetMap`));
    heading.append(routeNumber(route), copy);
    const stops = Array.isArray(route.stops) ? route.stops.filter(validPosition) : [];
    const metadata = node('div', 'route-meta');
    metadata.append(node('span', '', `${stops.length} позначок зупинок`), node('span', '', '© OpenStreetMap'));
    const saved = state.favoriteRoutes.some((item) => item.id === route.id);
    const actions = node('div', 'route-detail-actions');
    actions.append(button(saved ? '★ Маршрут в обраному' : '☆ Зберегти маршрут', 'button button-secondary', () => toggleFavoriteRoute(route)),
      button('Прибрати з карти', 'text-button', () => removeRoute(route.id)));
    const note = node('p', 'route-note', 'Платформа й зупинка можуть мати окремі позначки. GPS відфільтровано за номером і, коли доступно, типом транспорту; напрямок руху GPS не визначено. Зворотний напрямок оберіть окремо в каталозі.');
    const list = node('ol', 'route-stops');
    for (const stop of stops) {
      const item = node('li', 'route-stop');
      item.append(button(clean(stop.name || 'Зупинка'), '', () => showStop(stop)));
      list.append(item);
    }
    if (!stops.length) list.append(node('p', 'field-note', 'Зупинки з координатами не внесено до цього напрямку.'));
    const variants = relatedVariants(route);
    const variantsBox = node('div', 'route-variants');
    if (variants.length) {
      const explicit = Boolean(route.routeMasterId);
      variantsBox.append(node('label', 'field-label', explicit ? 'Напрямок маршруту' : 'Варіанти цього номера'));
      const select = node('select', 'direction-select');
      select.setAttribute('aria-label', explicit ? 'Напрямок маршруту' : 'Варіанти номера за типом і перевізником');
      for (const variant of [route, ...variants]) {
        const option = node('option', '', routeTitle(variant)); option.value = variant.id; select.append(option);
      }
      select.value = route.id;
      select.addEventListener('change', () => {
        const variant = variants.find((item) => item.id === select.value);
        if (variant) selectRoute(variant, { replaceId: route.id, returnTab: state.routeReturnTab });
      });
      variantsBox.append(select);
      if (!explicit) variantsBox.append(node('p', 'field-note', 'Збіг номера, типу й перевізника. Це можуть бути різні варіанти, не лише зворотний напрямок.'));
    }
    $('route-detail').replaceChildren(back, heading, metadata, actions, variantsBox, note, list);
  }
  function relatedVariants(route) {
    return (state.routes || []).filter((candidate) => {
      if (candidate.id === route.id) return false;
      if (route.routeMasterId) return candidate.routeMasterId === route.routeMasterId;
      return route.ref && normalizeRef(candidate.ref) === normalizeRef(route.ref)
        && modeOf(candidate.mode) === modeOf(route.mode)
        && clean(candidate.operator).toLocaleLowerCase('uk') === clean(route.operator).toLocaleLowerCase('uk');
    }).slice(0, 30);
  }
  async function chooseVehicleRoute(vehicle) {
    state.map.closePopup();
    state.routeReturnTab = 'routes-panel';
    const sequence = ++state.routeSequence;
    switchTab('routes-panel');
    $('route-catalog').hidden = true; $('route-detail').hidden = false;
    delete $('route-detail').dataset.routeId;
    const container = node('div');
    $('route-detail').replaceChildren(button('← Усі маршрути', 'route-detail-back', backFromRoute), container);
    if (vehicle.routeIsPublicNumber !== true) {
      empty(container, 'Номер маршруту невідомий', 'Джерело передало лише технічний ID. Оберіть потрібну схему в каталозі.'); return;
    }
    loading(container, 'Шукаємо схему маршруту…');
    const routes = await loadRoutes();
    if (!container.isConnected || sequence !== state.routeSequence) return;
    if (!routes) { empty(container, 'Каталог недоступний', 'Спробуйте ще раз трохи пізніше.', () => chooseVehicleRoute(vehicle)); return; }
    const vehicleMode = modeOf(vehicle.mode);
    const matches = routes.filter((route) => normalizeRef(route.ref) === normalizeRef(vehicle.route)
      && (vehicleMode === 'unknown' || modeOf(route.mode) === vehicleMode));
    if (!matches.length) {
      empty(container, 'Схеми в каталозі немає', 'GPS цього маршруту доступний, але відповідної схеми OpenStreetMap не знайдено.'); return;
    }
    if (matches.length === 1) { selectRoute(matches[0]); return; }
    container.replaceChildren(node('p', 'field-note', vehicleMode === 'unknown'
      ? 'Тип транспорту у GPS не визначено. Оберіть потрібний тип і варіант маршруту.'
      : 'GPS не визначає напрямок. Оберіть схему, яку хочете переглянути.'));
    for (const route of matches) container.append(makeRouteCard(route));
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
    box.append(pointActions(stop));
    const routes = node('div', 'popup-routes');
    loading(routes, 'Маршрути зупинки…');
    box.append(routes);
    return box;
  }
  async function loadStopRoutes(stop, container, popup) {
    const normalized = savedStop(stop);
    const key = [normalized.id, ...(normalized.osmIds || [])].sort().join(',');
    const cached = state.stopRouteCache.get(key);
    try {
      let routes;
      if (cached && cached.expires > Date.now()) routes = cached.routes;
      else {
        let pending = state.stopRoutePending.get(key);
        if (!pending) {
          pending = api('/api/stop-routes', { method: 'POST', body: { stop: normalized }, timeoutMs: 40_000 }).then((result) => {
            const list = Array.isArray(result.routes) ? result.routes.slice(0, 40) : [];
            while (state.stopRouteCache.size >= 100) state.stopRouteCache.delete(state.stopRouteCache.keys().next().value);
            state.stopRouteCache.set(key, { routes: list, expires: Date.now() + 300_000 });
            return list;
          }).finally(() => state.stopRoutePending.delete(key));
          state.stopRoutePending.set(key, pending);
        }
        routes = await pending;
      }
      if (!container.isConnected) return;
      if (!routes.length) { container.replaceChildren(node('p', 'field-note', 'Маршрути не внесені до цієї зупинки в OpenStreetMap. Прогноз прибуття недоступний.')); return; }
      container.replaceChildren(node('p', 'popup-routes-heading', 'Маршрути цієї зупинки'));
      for (const route of routes) {
        const item = button('', 'popup-route', () => { state.map.closePopup(); selectRoute(route); });
        item.append(routeNumber(route, true), node('span', '', `${MODE_NAMES[modeOf(route.mode)]} · ${routeTitle(route)}`));
        container.append(item);
      }
      container.append(node('p', 'field-note', 'Довідкові дані OSM. Без прогнозу прибуття.'));
    } catch {
      if (!container.isConnected) return;
      container.replaceChildren(node('p', 'field-note', 'Маршрути зараз недоступні.'),
        button('Спробувати ще раз', 'text-button', () => {
          loading(container, 'Маршрути зупинки…');
          updatePopupLayout(popup);
          loadStopRoutes(stop, container, popup);
        }));
    } finally {
      if (container.isConnected) updatePopupLayout(popup);
    }
  }
  function makeStopMarker(stop, layer) {
    const content = node('div', 'stop-marker');
    const marker = L.marker([stop.lat, stop.lon], {
      icon: L.divIcon({ html: content, className: 'stop-icon', iconSize: [13, 13], iconAnchor: [6, 6], popupAnchor: [0, -9] }),
      title: clean(stop.name || 'Зупинка'), keyboard: true,
    }).bindPopup(stopPopup(stop));
    marker.on('popupopen', () => {
      state.activeStop = stop; state.selectedPoint = stop;
      const content = stopPopup(stop);
      marker.setPopupContent(content);
      loadStopRoutes(stop, content.querySelector('.popup-routes'), marker.getPopup());
    });
    return marker.addTo(layer);
  }
  function showStop(stop) {
    if (!validPosition(stop)) return;
    state.activeStop = stop;
    state.selectedPoint = stop;
    setExpanded(false);
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
      const result = await api(`/api/stops?${new URLSearchParams({ lat: String(position.lat), lon: String(position.lon) })}`, { timeoutMs: 40_000 });
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
          state.selectedPoint = place;
          marker.bindPopup(pointPopup(place));
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
  function savedStop(stop) {
    const osmIds = Array.isArray(stop.osmIds) ? [...new Set(stop.osmIds.filter((id) => /^(node|way|relation)\/[1-9]\d*$/.test(id)))].slice(0, 20) : [];
    return { id: clean(stop.id, 120), name: clean(stop.name || 'Зупинка'), lat: stop.lat, lon: stop.lon, mode: modeOf(stop.mode), ...(osmIds.length ? { osmIds } : {}) };
  }
  function savedRoute(route) {
    return { id: clean(route.id, 120), ref: clean(route.ref, 40), name: clean(route.name, 240), from: clean(route.from), to: clean(route.to), mode: modeOf(route.mode), operator: clean(route.operator), city: 'kyiv' };
  }
  function readFavorites() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(FAVORITES_KEY) || 'null'); } catch { /* Try the previous format below. */ }
    if (saved?.version === 2) {
      state.favorites = Array.isArray(saved.stops) ? saved.stops.filter((stop) => validPosition(stop) && typeof stop.id === 'string').slice(0, 30).map(savedStop) : [];
      state.favoriteRoutes = Array.isArray(saved.routes) ? saved.routes.filter((route) => /^relation\/[1-9]\d*$/.test(route?.id)).slice(0, 30).map(savedRoute) : [];
      return;
    }
    try {
      const old = JSON.parse(localStorage.getItem(OLD_FAVORITES_KEY) || '[]');
      state.favorites = Array.isArray(old) ? old.filter((stop) => validPosition(stop) && typeof stop.id === 'string').slice(0, 30).map(savedStop) : [];
      // Keep v1 intact as a fallback if writing v2 fails; never overwrite it.
      localStorage.setItem(FAVORITES_KEY, JSON.stringify({ version: 2, stops: state.favorites, routes: [] }));
    } catch { /* Imported favorites remain available for this session. */ }
  }
  function saveFavorites(next, routes = state.favoriteRoutes) {
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify({ version: 2, stops: next, routes })); }
    catch { toast('Браузер не дозволив зберегти обране на цьому пристрої.'); return false; }
    state.favorites = next;
    state.favoriteRoutes = routes;
    renderFavorites();
    return true;
  }
  function toggleFavorite(stop) {
    if (!validPosition(stop) || !stop.id) return false;
    const exists = state.favorites.some((item) => item.id === stop.id);
    if (!exists && state.favorites.length >= 30) { toast('В обраному вже 30 зупинок. Спочатку приберіть зайву.'); return false; }
    state.favoriteTab = 'stops';
    const next = exists ? state.favorites.filter((item) => item.id !== stop.id) : [...state.favorites, savedStop(stop)];
    const success = saveFavorites(next);
    if (success) toast(exists ? 'Зупинку прибрано з обраного' : 'Зупинку збережено на цьому пристрої');
    return success;
  }
  function toggleFavoriteRoute(route) {
    if (!/^relation\/[1-9]\d*$/.test(route?.id)) return false;
    const exists = state.favoriteRoutes.some((item) => item.id === route.id);
    if (!exists && state.favoriteRoutes.length >= 30) { toast('В обраному вже 30 маршрутів. Спочатку приберіть зайвий.'); return false; }
    const next = exists ? state.favoriteRoutes.filter((item) => item.id !== route.id) : [...state.favoriteRoutes, savedRoute(route)];
    state.favoriteTab = 'routes';
    if (!saveFavorites(state.favorites, next)) return false;
    if (state.routes) renderRoutes();
    if (state.selectedRoute) renderRouteDetail(state.selectedRoute);
    toast(exists ? 'Маршрут прибрано з обраного' : 'Маршрут збережено на цьому пристрої');
    return true;
  }
  function renderFavorites() {
    const showRoutes = state.favoriteTab === 'routes';
    for (const kind of ['stops', 'routes']) {
      $(`favorites-${kind}`).classList.toggle('is-active', state.favoriteTab === kind);
      $(`favorites-${kind}`).setAttribute('aria-pressed', String(state.favoriteTab === kind));
    }
    const list = showRoutes ? state.favoriteRoutes : state.favorites;
    $('favorites-count').textContent = `${showRoutes ? 'Маршрути' : 'Зупинки'}: ${list.length}`;
    $('clear-favorites').hidden = !state.favorites.length && !state.favoriteRoutes.length;
    if (!list.length) {
      empty($('favorites-results'), showRoutes ? 'Ваші маршрути будуть тут' : 'Ваші зупинки будуть тут', showRoutes
        ? 'Натисніть зірочку біля маршруту в каталозі або в його картці.' : 'Натисніть зупинку на карті та збережіть її. Обране доступне лише на цьому пристрої.');
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of list) {
      const row = node('div', 'favorite-row');
      const remove = button('×', 'remove-favorite', () => showRoutes ? toggleFavoriteRoute(item) : toggleFavorite(item));
      remove.setAttribute('aria-label', `Прибрати з обраного: ${clean(showRoutes ? item.ref : item.name)}`);
      row.append(showRoutes ? makeRouteCard(item, () => selectRoute(item, { returnTab: 'favorites-panel' })) : stopCard(item), remove); fragment.append(row);
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
    for (const key of ['gps', 'lines', 'stops']) $(`toggle-${key}`).addEventListener('change', () => {
      state.settings[key] = $(`toggle-${key}`).checked;
      persistSettings(); applyMapSettings();
      if (key === 'gps' && state.settings.gps) refreshLive();
    });
    $('route-query').addEventListener('input', () => { if (state.routes) renderRoutes(); });
    for (const chip of document.querySelectorAll('#mode-filters .mode-chip')) chip.addEventListener('click', () => {
      state.catalogMode = chip.dataset.mode;
      for (const item of document.querySelectorAll('#mode-filters .mode-chip')) {
        const selected = item === chip; item.classList.toggle('is-active', selected); item.setAttribute('aria-pressed', String(selected));
      }
      if (state.routes) renderRoutes();
    });
    $('clear-route').addEventListener('click', () => { if (state.selectedRoute) removeRoute(state.selectedRoute.id); });
    $('open-route-detail').addEventListener('click', () => switchTab('routes-panel'));
    $('home').addEventListener('click', (event) => {
      event.preventDefault(); clearRoute(); state.stopsLayer.clearLayers(); state.placeLayer.clearLayers();
      state.nearbySequence++; $('nearby').disabled = false;
      switchTab('map-panel', false); fitPoints(L.latLngBounds(KYIV_BOUNDS), 12);
    });
    $('clear-favorites').addEventListener('click', () => { if (saveFavorites([], [])) toast('Обране на цьому пристрої очищено'); });
    for (const kind of ['stops', 'routes']) $(`favorites-${kind}`).addEventListener('click', () => { state.favoriteTab = kind; renderFavorites(); });
    $('about-button').addEventListener('click', () => $('about-dialog').showModal());
    $('close-about').addEventListener('click', () => $('about-dialog').close());
    $('close-about-bottom').addEventListener('click', () => $('about-dialog').close());
    $('about-dialog').addEventListener('click', (event) => { if (event.target === $('about-dialog')) $('about-dialog').close(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.token) { renderVehicles(); refreshLive(); } });
    window.addEventListener('resize', () => { state.map?.invalidateSize(); updatePopupLayout(state.openPopup); });
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
    readSettings();
    initializeMap();
    bindInterface();
    publishBridge();
    if (requestedPanel && $(requestedPanel)?.classList.contains('panel')) { switchTab(requestedPanel); requestedPanel = null; }
    await refreshLive();
    setInterval(() => { if (!document.hidden && state.token) refreshLive(); }, 20_000);
    setInterval(() => { if (state.token) renderVehicles(); }, 5000);
  }
  document.addEventListener('DOMContentLoaded', boot, { once: true });
})();

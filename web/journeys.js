(() => {
  'use strict';
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
  const button = (text, action, cls = 'feature-button') => { const node = el('button', text, cls); node.type = 'button'; node.addEventListener('click', action); return node; };
  const names = { bus: 'Автобус', trolleybus: 'Тролейбус', tram: 'Трамвай', subway: 'Метро', light_rail: 'Легкорейковий' };
  let initialized = false;
  function init(app) {
    if (initialized) return; initialized = true;
    if (!document.querySelector('link[href="/features.css"]')) { const css = el('link'); css.rel = 'stylesheet'; css.href = '/features.css'; document.head.append(css); }
    const content = el('div', undefined, 'feature-panel');
    const intro = el('p', 'Оберіть початок і кінець поїздки. Точку також можна задати натисканням на карту.', 'feature-muted');
    const form = el('form', undefined, 'journey-form');
    const fields = {};
    let requestVersion = 0, drawVersion = 0, layer = null;
    const clearDrawing = () => { drawVersion++; if (layer) app.map.removeLayer(layer); layer = null; };
    window.addEventListener('mappi:map-reset', clearDrawing);
    const results = el('div', undefined, 'journey-results'); results.setAttribute('aria-live', 'polite');
    const markChanged = () => { requestVersion++; submit.disabled = false; results.replaceChildren(); clearDrawing(); };
    function setPoint(kind, point) {
      if (!fields[kind] || !Number.isFinite(point?.lat) || !Number.isFinite(point?.lon)) return;
      const field = fields[kind]; field.version++; field.point = { lat: point.lat, lon: point.lon, name: point.name || `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}` };
      field.input.value = field.point.name; field.list.replaceChildren(); field.hint.textContent = 'Точку обрано'; markChanged();
    }
    for (const [kind, label] of [['from', 'Звідки'], ['to', 'Куди']]) {
      const block = el('div', undefined, 'journey-field');
      const caption = el('label', label); caption.htmlFor = `journey-${kind}`;
      const row = el('div', undefined, 'feature-input-row');
      const input = el('input'); input.id = `journey-${kind}`; input.placeholder = kind === 'from' ? 'Адреса або зупинка' : 'Місце призначення'; input.maxLength = 150; input.autocomplete = 'off';
      const hint = el('span', '', 'feature-muted'); const list = el('div', undefined, 'feature-options');
      const field = fields[kind] = { input, hint, list, point: null, version: 0 };
      async function search() {
        const query = input.value.trim(); const version = ++field.version; field.point = null; markChanged(); list.replaceChildren();
        if (query.length < 2) { hint.textContent = 'Введіть щонайменше 2 символи'; return; }
        hint.textContent = 'Шукаємо місце…';
        try {
          const data = await app.api(`/api/search?q=${encodeURIComponent(query)}`);
          if (version !== field.version) return;
          hint.textContent = data.places?.length ? 'Оберіть місце зі списку' : 'Місць не знайдено. Уточніть назву.';
          for (const place of data.places || []) list.append(button(place.name, () => setPoint(kind, place), 'feature-option'));
        } catch (error) { if (version === field.version) hint.textContent = error.message; }
      }
      input.addEventListener('input', () => { field.version++; field.point = null; list.replaceChildren(); hint.textContent = 'Натисніть «Знайти» й оберіть місце'; markChanged(); });
      input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); search(); } });
      row.append(input, button('Знайти', search)); block.append(caption, row, hint, list); form.append(block);
    }
    const actions = el('div', undefined, 'feature-actions');
    actions.append(button('⇅ Поміняти місцями', () => {
      const a = fields.from.point, b = fields.to.point, av = fields.from.input.value, bv = fields.to.input.value;
      fields.from.version++; fields.to.version++; fields.from.point = b; fields.to.point = a;
      fields.from.input.value = bv; fields.to.input.value = av;
      for (const field of Object.values(fields)) { field.list.replaceChildren(); field.hint.textContent = field.point ? 'Точку обрано' : 'Оберіть місце'; }
      markChanged();
    }), button('Моє місце → звідки', () => {
      const field = fields.from, version = ++field.version;
      field.point = null; field.list.replaceChildren(); markChanged();
      if (!navigator.geolocation) { field.hint.textContent = 'Геолокація недоступна'; return; }
      field.hint.textContent = 'Визначаємо розташування…';
      navigator.geolocation.getCurrentPosition(position => {
        if (version === field.version) setPoint('from', { lat: position.coords.latitude, lon: position.coords.longitude, name: 'Моє місце' });
      }, () => { if (version === field.version) field.hint.textContent = 'Не вдалося визначити місце. Вкажіть його на карті.'; }, { timeout: 12000, maximumAge: 30000 });
    })); form.append(actions);
    const modes = el('fieldset', undefined, 'feature-modes'); modes.append(el('legend', 'Транспорт'));
    const checks = [];
    for (const [value, label] of Object.entries(names)) {
      const wrap = el('label'), check = el('input'); check.type = 'checkbox'; check.value = value; check.checked = true; checks.push(check); check.addEventListener('change', markChanged); wrap.append(check, document.createTextNode(label)); modes.append(wrap);
    }
    const directLabel = el('label', undefined, 'feature-check'), direct = el('input'); direct.type = 'checkbox'; direct.addEventListener('change', markChanged); directLabel.append(direct, document.createTextNode('Лише без пересадок'));
    const sortLabel = el('label', 'Порядок варіантів', 'feature-stack'), sort = el('select'); sort.setAttribute('aria-label', 'Порядок варіантів');
    for (const [value, title] of [['transfers', 'Менше пересадок'], ['walk', 'Менше пішки']]) { const option = el('option', title); option.value = value; sort.append(option); }
    sort.addEventListener('change', markChanged); sortLabel.append(sort);
    const submit = el('button', 'Знайти поїздку', 'feature-primary'); submit.type = 'submit';
    form.append(modes, directLabel, sortLabel, submit);
    const notice = el('p', 'Пошук за схемами маршрутів: до однієї пересадки. Час прибуття, тарифи й зміни руху потребують додаткових даних. Для розрахунку пішого шляху координати передаються routing.openstreetmap.de.', 'feature-muted');
    const attribution = el('a', 'Пішохідні маршрути: FOSSGIS / OpenStreetMap'); attribution.href = 'https://routing.openstreetmap.de/about.html'; attribution.target = '_blank'; attribution.rel = 'noopener noreferrer'; attribution.className = 'feature-source';
    const fixMap = el('a', 'Повідомити про помилку на карті OSM'); fixMap.href = 'https://www.openstreetmap.org/fixthemap'; fixMap.target = '_blank'; fixMap.rel = 'noopener noreferrer'; fixMap.className = 'feature-source';
    content.append(intro, form, results, notice, attribution, fixMap);
    app.registerPanel({ id: 'journeys-panel', label: 'Поїздка', title: 'Куди їдемо?', kicker: 'ВІД ТОЧКИ ДО ТОЧКИ', content });
    window.addEventListener('mappi:plan-point', event => { setPoint(event.detail?.kind, event.detail?.point); app.showPanel('journeys-panel'); });
    async function draw(plan, output) {
      app.clearMap?.();
      clearDrawing(); const version = drawVersion; const nextLayer = L.featureGroup().addTo(app.map); layer = nextLayer;
      output.textContent = 'Завантажуємо схеми на карту…';
      const palette = ['#087f8c', '#ba6b21']; let fullRoutes = false;
      try {
        for (const walk of plan.walks || []) if (walk.verified && walk.lines?.length) L.polyline(walk.lines, { color: '#436176', weight: 4, dashArray: '5 7' }).addTo(nextLayer);
        for (const [index, leg] of plan.legs.entries()) {
          let lines = leg.lines;
          if (!lines?.length && /^relation\/[1-9]\d*$/.test(leg.routeId)) { const geometry = await app.api(`/api/route?id=${encodeURIComponent(leg.routeId)}`, { timeoutMs: 65000 }); if (version !== drawVersion) return; lines = geometry.lines; fullRoutes = true; }
          if (lines?.length) L.polyline(lines, { color: palette[index % palette.length], weight: 6, opacity: .85 }).addTo(nextLayer);
          for (const [kind, point] of [['Посадка', leg.board], ['Вихід', leg.alight]]) {
            if (Number.isFinite(point?.lat) && Number.isFinite(point?.lon)) L.circleMarker([point.lat, point.lon], { radius: 7, weight: 3, color: palette[index % palette.length], fillColor: '#fff', fillOpacity: 1 }).bindPopup(el('div', `${kind}: ${point.name}`)).addTo(nextLayer);
          }
        }
        if (version !== drawVersion) return;
        for (const [kind, text] of [['from', 'A'], ['to', 'B']]) { const p = fields[kind].point; if (p) L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'journey-pin', html: text, iconSize: [30, 30], iconAnchor: [15, 30] }) }).bindPopup(el('div', p.name)).addTo(nextLayer); }
        if (nextLayer.getLayers().length) (app.focusMap || app.fitBounds)(nextLayer.getBounds());
        output.textContent = fullRoutes ? 'На карті повні схеми обраних маршрутів; місця посадки й виходу позначено.' : 'Поїздку показано на карті.';
      } catch (error) { if (version === drawVersion) output.textContent = `Частину схеми не завантажено: ${error.message}`; }
    }
    form.addEventListener('submit', async event => {
      event.preventDefault(); const version = ++requestVersion; clearDrawing(); results.replaceChildren();
      if (!fields.from.point || !fields.to.point) { results.append(el('p', 'Спершу оберіть обидві точки зі списку пошуку або на карті.', 'feature-error')); return; }
      const selectedModes = checks.filter(check => check.checked).map(check => check.value);
      if (!selectedModes.length) { results.append(el('p', 'Оберіть хоча б один вид транспорту.', 'feature-error')); return; }
      submit.disabled = true; results.append(el('p', 'Шукаємо сполучення та перевіряємо піші підходи… Перший пошук може тривати до хвилини.', 'feature-muted'));
      try {
        const data = await app.api('/api/journeys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: fields.from.point, to: fields.to.point, modes: selectedModes, maxTransfers: direct.checked ? 0 : 1, sort: sort.value }), timeoutMs: 90000 });
        if (version !== requestVersion) return;
        results.replaceChildren();
        if (!data.itineraries?.length) results.append(el('p', 'У доступних схемах сполучення не знайдено. Спробуйте інші точки чи дозвольте пересадку. Це не означає, що транспорту немає.', 'feature-notice'));
        for (const [index, plan] of (data.itineraries || []).entries()) {
          const card = el('article', undefined, 'journey-card');
          card.append(el('h3', `Варіант ${index + 1} · ${plan.transfers ? '1 пересадка' : 'без пересадок'}`));
          for (const leg of plan.legs || []) {
            const modeName = names[leg.mode] || 'Транспорт';
            const title = leg.mode === 'subway' && leg.name ? leg.name : `${modeName}${leg.ref && leg.ref !== modeName ? ` ${leg.ref}` : ''}`;
            const row = el('div', undefined, 'journey-leg'); row.append(el('strong', title), el('p', `${leg.board?.name || 'Посадка'} → ${leg.alight?.name || 'Вихід'}`));
            if (Number.isFinite(leg.stopCount)) row.append(el('small', `${leg.routeId?.startsWith('metro-line:') ? 'Перегонів між станціями' : 'Проміжків за даними OSM'}: ${leg.stopCount}`)); card.append(row);
          }
          for (const walk of plan.walks || []) {
            const label = { access: 'До посадки', egress: 'Після виходу', transfer: 'Перехід' }[walk.kind] || 'Пішки';
            const distance = Number.isFinite(walk.meters) ? `${Math.round(walk.meters)} м${walk.verified ? ' пішки' : ' по прямій; піший шлях не перевірено'}` : 'довжина переходу невідома';
            card.append(el('p', `${label}: ${distance}${walk.verified && Number.isFinite(walk.seconds) ? ` · ≈ ${Math.max(1, Math.round(walk.seconds / 60))} хв пішки` : ''}`, 'feature-muted'));
          }
          const drawStatus = el('p', '', 'feature-muted'); drawStatus.setAttribute('aria-live', 'polite');
          card.append(button('Показати на карті', () => draw(plan, drawStatus), 'feature-primary'), drawStatus); results.append(card);
        }
        for (const text of data.notices || []) results.append(el('p', text, 'feature-notice'));
        if (typeof data.source === 'string') results.append(el('p', data.source, 'feature-source'));
      } catch (error) { if (version === requestVersion) results.replaceChildren(el('p', error.message, 'feature-error')); }
      finally { if (version === requestVersion) submit.disabled = false; }
    });
  }
  window.addEventListener('mappi:ready', event => init(event.detail));
  if (window.Mappi) init(window.Mappi);
})();

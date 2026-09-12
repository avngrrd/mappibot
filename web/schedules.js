(() => {
  'use strict';
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
  let initialized = false;
  function init(app) {
    if (initialized) return; initialized = true;
    const content = el('div', undefined, 'feature-panel');
    const intro = el('p', 'Офіційно опубліковані розклади Києва. Час за Києвом; оперативні зміни та затримки можуть відрізнятися.', 'feature-muted');
    const controls = el('div', undefined, 'feature-stack');
    const systemLabel = el('label', 'Вид транспорту'), system = el('select'); system.id = 'schedule-system'; systemLabel.htmlFor = system.id;
    const filterLabel = el('label', 'Знайти станцію'), filter = el('input'); filter.id = 'schedule-filter'; filterLabel.htmlFor = filter.id; filter.placeholder = 'Назва станції'; filter.maxLength = 80;
    const stationLabel = el('label', 'Станція'), station = el('select'); station.id = 'schedule-station'; stationLabel.htmlFor = station.id;
    const load = el('button', 'Показати розклад', 'feature-primary'); load.type = 'button';
    const output = el('div', undefined, 'schedule-output'); output.setAttribute('aria-live', 'polite');
    const state = { catalog: null, loading: false, version: 0 };
    controls.append(systemLabel, system, filterLabel, filter, stationLabel, station, load); controls.hidden = true;
    content.append(intro, controls, output);
    function populateStations() {
      state.version++; load.disabled = false; station.replaceChildren(); output.replaceChildren();
      const q = filter.value.toLocaleLowerCase('uk').trim();
      const points = state.catalog?.systems.find(item => item.id === system.value)?.stations || [];
      for (const point of points) {
        if (q && !point.name.toLocaleLowerCase('uk').includes(q)) continue;
        const duplicate = points.some(other => other.id !== point.id && other.name === point.name);
        const option = el('option', `${point.name}${point.line ? ` · ${point.line}` : ''}${duplicate ? ` · код ${point.id}` : ''}`); option.value = point.id; station.append(option);
      }
      load.disabled = !station.options.length;
      if (!station.options.length) output.append(el('p', 'Станцій з такою назвою немає.', 'feature-muted'));
    }
    async function catalog() {
      if (state.catalog || state.loading) return; state.loading = true; output.replaceChildren(el('p', 'Завантажуємо станції…', 'feature-muted'));
      try {
        state.catalog = await app.api('/api/schedules/catalog', { timeoutMs: 20000 });
        for (const item of state.catalog.systems) { const option = el('option', item.name); option.value = item.id; system.append(option); }
        controls.hidden = false; populateStations();
      } catch (error) {
        const retry = el('button', 'Спробувати ще раз', 'feature-button'); retry.type = 'button'; retry.addEventListener('click', catalog); output.replaceChildren(el('p', error.message, 'feature-error'), retry);
      } finally { state.loading = false; }
    }
    system.addEventListener('change', () => { filter.value = ''; populateStations(); }); filter.addEventListener('input', populateStations);
    station.addEventListener('change', () => { state.version++; load.disabled = false; output.replaceChildren(); });
    function table(headers, rows) {
      const wrap = el('div', undefined, 'schedule-table-wrap'), table = el('table', undefined, 'schedule-table'), head = el('thead'), hr = el('tr'), body = el('tbody');
      for (const title of headers) { const th = el('th', title); th.scope = 'col'; hr.append(th); } head.append(hr);
      for (const values of rows) { const row = el('tr'); for (const value of values) row.append(el('td', value)); body.append(row); }
      table.append(head, body); wrap.append(table); return wrap;
    }
    load.addEventListener('click', async () => {
      if (!station.value) return; const version = ++state.version; load.disabled = true; output.replaceChildren(el('p', 'Завантажуємо розклад…', 'feature-muted'));
      try {
        const data = await app.api(`/api/schedules?system=${encodeURIComponent(system.value)}&station=${encodeURIComponent(station.value)}`, { timeoutMs: 25000 });
        if (version !== state.version) return; output.replaceChildren(el('h3', data.station.name));
        const onMap = el('button', 'Станція на карті', 'feature-button'); onMap.type = 'button'; onMap.addEventListener('click', () => {
          const node = el('div', data.station.name); app.showPanel('map-panel'); (app.focusMap || app.fitBounds)([[data.station.lat, data.station.lon]]); L.popup().setLatLng([data.station.lat, data.station.lon]).setContent(node).openOn(app.map);
        }); output.append(onMap);
        for (const direction of data.directions) {
          const section = el('section', undefined, 'schedule-card'); section.append(el('h4', direction.name));
          if (direction.first || direction.last) section.append(el('p', `Перший: ${direction.first || 'не вказано'} · Останній: ${direction.last || 'не вказано'}`, 'schedule-hours'));
          const intervals = direction.intervals || [], departures = direction.departures || [];
          const days = [...new Set([...intervals, ...departures].map(row => row.days))];
          for (const day of days) {
            const group = el('details'); group.open = days.length === 1; group.append(el('summary', day));
            const periodRows = intervals.filter(row => row.days === day);
            if (periodRows.length) group.append(table(['Період', 'Інтервал'], periodRows.map(row => [row.period, row.label])));
            const timeRows = departures.filter(row => row.days === day);
            if (timeRows.length) group.append(table(['Відправлення', 'Поїзд'], timeRows.map(row => [row.time, row.train])));
            section.append(group);
          }
          output.append(section);
        }
        output.append(el('p', data.notice, 'feature-notice'), el('p', data.source, 'feature-source'));
      } catch (error) { if (version === state.version) output.replaceChildren(el('p', error.message, 'feature-error')); }
      finally { if (version === state.version) load.disabled = false; }
    });
    app.registerPanel({ id: 'schedules-panel', label: 'Розклад', title: 'Розклад руху', kicker: 'МЕТРО · ЕЛЕКТРИЧКА · ФУНІКУЛЕР', content, onOpen: catalog });
  }
  window.addEventListener('mappi:ready', event => init(event.detail));
  if (window.Mappi) init(window.Mappi);
})();

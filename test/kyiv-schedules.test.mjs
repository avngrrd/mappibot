import test from 'node:test';
import assert from 'node:assert/strict';
import { createKyivSchedules } from '../src/kyiv-schedules.mjs';

const TIME = Date.UTC(2026, 8, 12, 10, 30);
const station = (id, name, extra = {}, geometry = { x: 30.52, y: 50.44 }) => ({ attributes: { code1: id, name, ...extra }, geometry });
const row = attributes => ({ attributes });
function fixtures() {
  return {
    4: [station('m1', 'Станція метро', { line: 'Лінія 1' })],
    7: [station('fn01', 'Верхня станція'), station('fn02', 'Нижня станція')],
    10: [station('12_00', 'Дарниця')],
    13: [row({ code1: 'm1', line: 'Лінія 1', napryamok: 'Прямий', first_trn1: '05:30', last_trn1: '23:30' }),
      row({ code1: 'm1', line: 'Лінія 1', napryamok: 'Зворотній', first_trn1: 'invalid', first_trn2: '05:42:00', last_trn1: '23:42' })],
    14: [row({ line: 'Лінія 1', timeperiod: '06:00-07:00', st_weekday: '7:30-5:30', rv_weekday: '8:45-4:00', st_holiday: '9:15', rv_holiday: '11:00' }),
      row({ line: 'Інша лінія', timeperiod: '06:00-07:00', st_weekday: '1:00' })],
    17: [row({ code1: 'fn01', line: 'Фунікулер', napryamok: 'Донизу', first_trn1: '07:00', last_trn1: '21:45' }),
      row({ code1: 'fn02', line: 'Фунікулер', napryamok: 'Вверх', first_trn1: '07:00', last_trn1: '21:45' })],
    18: [row({ line: 'Фунікулер', timeperiod: '07:00-07:54', st_weekday: '15:00', rv_weekday: '14:00', st_holiday: '15:00', rv_holiday: '14:00' })],
    20: [row({ code1: '12_00', actual: 1, num_route: 'Дарниця - Святошин (E2)', napryamok: 'за годинниковою стрілкою', type: 'щоденно', train: 'А01', arrival: null, departure: '05:46' }),
      row({ code1: '12_00', actual: 1, num_route: 'Дарниця - Святошин (E2)', napryamok: 'за годинниковою стрілкою', type: 'крім сб., нд.', train: 'А03', arrival: '06:10', departure: '06:11' })]
  };
}
function harness(data = fixtures(), now = () => TIME) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const id = Number(new URL(url).pathname.match(/\/(\d+)\/query$/)[1]);
    return new Response(JSON.stringify({ features: data[id] }), { headers: { 'Content-Type': 'application/json' } });
  };
  return { provider: createKyivSchedules({ fetchImpl, now }), calls };
}

test('catalog preserves official station codes, separates systems and rejects bad coordinates', async () => {
  const data = fixtures();
  data[4].push(station('bad', 'Foreign point', {}, { x: -77, y: -12 }), station('missing', '', {}));
  const { provider, calls } = harness(data);
  const result = await provider.catalog();
  assert.deepEqual(result.systems.map(x => x.id), ['metro', 'rail', 'funicular']);
  assert.deepEqual(result.systems[0].stations, [{ id: 'm1', name: 'Станція метро', lat: 50.44, lon: 30.52, line: 'Лінія 1' }]);
  assert.equal(result.systems[1].stations[0].id, '12_00');
  assert.equal(calls.length, 3);
  assert.ok(calls.every(x => x.url.includes('outSR=4326') && x.options.signal));
  assert.equal(result.fetchedAt, new Date(TIME).toISOString());
});

test('metro keeps distinct direction intervals and preserves ranges without an invented average', async () => {
  const { provider } = harness();
  const result = await provider.timetable('metro', 'm1');
  assert.deepEqual(result.directions.map(x => [x.id, x.first, x.last]), [['forward', '05:30', '23:30'], ['reverse', '05:42', '23:42']]);
  const weekday = result.directions[0].intervals.find(x => x.days === 'Робочі дні');
  assert.equal(weekday.minutes, null);
  assert.equal(weekday.label, '7:30-5:30 хв:сек');
  assert.equal(result.directions[0].intervals.find(x => x.days === 'Вихідні дні').minutes, 9.25);
  assert.equal(result.directions[0].intervals.length, 2);
  assert.match(result.notice, /Плановий розклад/);
  assert.ok(!('nextDeparture' in result));
});

test('rail exposes published train times and day labels, excluding inactive or invalid departures', async () => {
  const data = fixtures();
  data[20].push(row({ ...data[20][0].attributes, train: 'OFF', actual: 0 }),
    row({ ...data[20][0].attributes, train: 'ARRIVAL_ONLY', departure: null, arrival: '23:00' }),
    row({ ...data[20][0].attributes, train: 'BAD', departure: '10:88' }));
  const { provider } = harness(data);
  const result = await provider.timetable('rail', '12_00');
  assert.deepEqual(result.directions[0].departures.map(x => [x.train, x.time, x.days]), [['А01', '05:46', 'щоденно'], ['А03', '06:11', 'крім сб., нд.']]);
  assert.equal(result.directions[0].departures[1].arrival, '06:10');
  assert.ok(!('first' in result.directions[0]));
});

test('funicular uses station departure direction rather than swapping uphill/downhill', async () => {
  const { provider } = harness();
  const upper = await provider.timetable('funicular', 'fn01');
  const lower = await provider.timetable('funicular', 'fn02');
  assert.equal(upper.directions[0].id, 'down');
  assert.equal(upper.directions[0].intervals[0].minutes, 14);
  assert.equal(lower.directions[0].id, 'up');
  assert.equal(lower.directions[0].intervals[0].minutes, 15);
});

test('user inputs cannot select arbitrary GIS layers or interpolate a query', async () => {
  const { provider, calls } = harness();
  await assert.rejects(provider.timetable('__proto__', 'm1'), /Оберіть/);
  await assert.rejects(provider.timetable('metro', 'm1&where=1=1'), /Оберіть/);
  await assert.rejects(provider.timetable('metro', 1), /Оберіть/);
  assert.equal(calls.length, 0);
  await assert.rejects(provider.timetable('metro', 'not_in_catalog'), /не знайдено/);
  assert.equal(calls.length, 1);
});

test('concurrent requests share a fetch; expired schedule fetch failure does not reuse stale rows', async () => {
  let clock = TIME;
  let failed = false;
  let requests = 0;
  const data = fixtures();
  const provider = createKyivSchedules({ now: () => clock, fetchImpl: async url => {
    requests++;
    if (failed) throw new Error('private upstream details');
    const id = Number(new URL(url).pathname.match(/\/(\d+)\/query$/)[1]);
    await new Promise(resolve => setTimeout(resolve, 5));
    return new Response(JSON.stringify({ features: data[id] }));
  } });
  await Promise.all([provider.timetable('metro', 'm1'), provider.timetable('metro', 'm1')]);
  assert.equal(requests, 3);
  clock += 14 * 60_000;
  await provider.timetable('metro', 'm1');
  assert.equal(requests, 3);
  clock += 60_000;
  failed = true;
  await assert.rejects(provider.timetable('metro', 'm1'), /тимчасово недоступні/);
  assert.equal(requests, 5);
});

test('rejects upstream error envelopes, truncated pages and oversized streaming bodies', async () => {
  for (const response of [
    new Response(JSON.stringify({ error: { code: 403 }, features: fixtures()[4] })),
    new Response(JSON.stringify({ exceededTransferLimit: true, features: fixtures()[4] })),
    new Response('x'.repeat(2_000_001)),
    new Response('{}', { headers: { 'content-length': '2000001' } })
  ]) {
    const provider = createKyivSchedules({ fetchImpl: async () => response, now: () => TIME });
    await assert.rejects(provider.timetable('metro', 'm1'), /тимчасово недоступні/);
  }
});

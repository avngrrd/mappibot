import { createEasyWay } from '../src/easyway.mjs';

// Run: node --env-file-if-exists=.env scripts/check-easyway.mjs
// Output is deliberately limited to status and documented permission identifiers/limits.
function safePermissions(data) {
  const root = data?.response ?? data;
  const container = root?.permission ?? root?.permissions;
  const candidates = Array.isArray(container) ? container : Array.isArray(container?.permission)
    ? container.permission : container && typeof container === 'object' ? [container] : [];
  const result = [];
  for (const entry of candidates.slice(0, 100)) {
    const attributes = entry?.['@attributes'] ?? entry;
    const city = attributes?.city;
    const method = attributes?.function;
    if (typeof city !== 'string' || !/^(?:\*|[a-z][a-z0-9_-]{0,39})$/.test(city)
      || typeof method !== 'string' || !/^(?:\*|[A-Za-z]+\.[A-Za-z]+)$/.test(method) || method.length > 80) continue;
    const limits = {};
    for (const period of ['second', 'minute', 'hour', 'day', 'month', 'total']) {
      const value = entry?.[period]?.limit;
      if (value === undefined || value === null || value === '') continue;
      const number = Number(value);
      if (Number.isSafeInteger(number) && number >= 0) limits[period] = number;
    }
    result.push({ city, function: method, limits });
  }
  return result;
}

try {
  const api = createEasyWay({ login: process.env.EASYWAY_LOGIN, password: process.env.EASYWAY_PASSWORD });
  const status = await api.status();
  const permissions = safePermissions(status.permissions);
  console.log(JSON.stringify({
    configured: status.configured, connected: status.connected,
    ...(status.checkedAt ? { checkedAt: status.checkedAt } : {}),
    ...(status.message ? { message: status.message } : {}), permissions,
    ...(status.connected && !permissions.length ? { notice: 'Зіставлення прав із фактичним JSON потрібно перевірити окремо.' } : {})
  }, null, 2));
  if (!status.connected) process.exitCode = 2;
} catch {
  console.error('Не вдалося перевірити підключення EasyWay. Облікові дані не виводяться.');
  process.exitCode = 2;
}

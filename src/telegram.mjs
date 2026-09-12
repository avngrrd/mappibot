import { setTimeout as delay } from 'node:timers/promises';

export class TelegramError extends Error {
  constructor(code, retryAfter = 0) {
    super(`Telegram API error (${code})`);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function createTelegram(token, { fetchImpl = fetch } = {}) {
  if (!/^\d+:[\w-]{20,}$/.test(token ?? '')) throw new Error('TELEGRAM_BOT_TOKEN is missing or invalid');
  return {
    async call(method, payload = {}, { signal } = {}) {
      if (!/^[a-zA-Z]+$/.test(method)) throw new Error('Invalid Telegram method');
      // Never log request URLs: Bot API authentication is part of the path.
      let response;
      try {
        response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(method === 'getUpdates' ? 40000 : 15000)]) : AbortSignal.timeout(method === 'getUpdates' ? 40000 : 15000),
          redirect: 'error'
        });
      } catch { throw new TelegramError('network'); }
      let data;
      try { data = await response.json(); } catch { throw new TelegramError(response.status); }
      if (!response.ok || !data.ok) {
        if (method === 'answerCallbackQuery' && data.error_code === 400) return false;
        throw new TelegramError(data.error_code || response.status, Number(data.parameters?.retry_after) || 0);
      }
      return data.result;
    }
  };
}

export async function runPolling({ telegram, bot, store, signal, log = console.log }) {
  let failures = 0;
  while (!signal?.aborted) {
    try {
      const updates = await telegram.call('getUpdates', {
        offset: store.offset, timeout: 25, limit: 20, allowed_updates: ['message', 'callback_query']
      }, { signal });
      for (const update of updates) {
        if (signal?.aborted) break;
        if (!Number.isSafeInteger(update.update_id) || update.update_id < store.offset) continue;
        try {
          await bot.handleUpdate(update);
        } catch (error) {
          if (!(error instanceof TelegramError) || ![400, 403].includes(error.code)) throw error;
          log('Skipped an undeliverable Telegram response.');
        }
        store.offset = update.update_id + 1;
        await store.save();
      }
      failures = 0;
    } catch (error) {
      if (error instanceof TelegramError && [401, 409].includes(error.code)) throw error;
      failures += 1;
      log('Temporary bot/network error; retrying.');
      const retryAfter = Number(error.retryAfter);
      const retryMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30000, 1000 * 2 ** Math.min(failures, 5));
      await delay(retryMs, undefined, { signal }).catch(() => {});
    }
  }
}

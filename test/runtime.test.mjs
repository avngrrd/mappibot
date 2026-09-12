import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, utimes, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTelegram, TelegramError, runPolling } from '../src/telegram.mjs';
import { openStore, acquireLock } from '../src/store.mjs';

test('network and Telegram failures never expose token or request contents', async () => {
  const token = '123456:' + 'x'.repeat(30);
  const api = createTelegram(token, { fetchImpl: async () => { throw new Error(`failed https://host/${token}`); } });
  await assert.rejects(api.call('getMe'), error => !String(error).includes(token) && error.code === 'network');
  const rejected = createTelegram(token, { fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error_code: 429, description: token, parameters: { retry_after: 7 } }) }) });
  await assert.rejects(rejected.call('getMe'), error => error.retryAfter === 7 && !String(error).includes(token));
});

test('state survives restart; corrupt state does not silently reset access', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mappi-test-'));
  try {
    const store = await openStore(dir);
    store.offset = 123;
    store.users['42'] = { favorites: [{ id: 'node/1', name: 'Saved stop' }] };
    await store.save();
    assert.equal((await openStore(dir)).users['42'].favorites[0].name, 'Saved stop');
    assert.equal((await openStore(dir)).offset, 123);
    await writeFile(path.join(dir, 'state.json'), 'broken');
    await assert.rejects(openStore(dir), /invalid/);
  } finally { await rm(dir, { recursive: true }); }
});

test('only one process can hold a data directory lock', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mappi-lock-'));
  try {
    const release = await acquireLock(dir);
    await assert.rejects(acquireLock(dir), /already/);
    await release();
    await (await acquireLock(dir))();
  } finally { await rm(dir, { recursive: true }); }
});

test('polling advances saved offset only after processing and stops on conflict', async () => {
  const order = [];
  const store = { offset: 10, save: async () => { order.push('saved'); } };
  let calls = 0;
  const telegram = { call: async (method, body) => {
    calls++;
    if (calls === 1) { assert.equal(body.offset, 10); return [{ update_id: 12, message: {} }]; }
    assert.equal(body.offset, 13);
    throw new TelegramError(409);
  } };
  await assert.rejects(runPolling({ telegram, store, bot: { handleUpdate: async () => order.push('handled') }, log: () => {} }), error => error.code === 409);
  assert.deepEqual(order, ['handled', 'saved']);
});

test('an abandoned lock expires without depending on a reused Docker PID', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mappi-crash-'));
  try {
    const lock = path.join(dir, 'process.lock');
    await mkdir(lock);
    const old = new Date(Date.now() - 120000);
    await utimes(lock, old, old);
    const release = await acquireLock(dir);
    await release();
  } finally { await rm(dir, { recursive: true }); }
});

test('an expired callback acknowledgement does not block update processing', async () => {
  const token = '123456:' + 'x'.repeat(30);
  const api = createTelegram(token, { fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error_code: 400 }) }) });
  assert.equal(await api.call('answerCallbackQuery', { callback_query_id: 'expired' }), false);
  await assert.rejects(api.call('sendMessage'), error => error.code === 400);
});

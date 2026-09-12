import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';

export async function openStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'state.json');
  let data = { offset: 0, users: {} };
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
    if (!Number.isSafeInteger(data.offset) || data.offset < 0 || !data.users || typeof data.users !== 'object' || Array.isArray(data.users)) {
      throw new Error('Invalid state');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Saved state is invalid; restore state.json before starting.');
  }
  const store = {
    offset: data.offset,
    users: data.users,
    async save() {
      const temp = file + '.tmp';
      await writeFile(temp, JSON.stringify({ offset: store.offset, users: store.users }), { mode: 0o600 });
      await rename(temp, file);
    }
  };
  return store;
}

export async function acquireLock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    return await lockfile.lock(directory, {
      lockfilePath: path.join(directory, 'process.lock'),
      stale: 60000, update: 20000, retries: 0
    });
  } catch (error) {
    if (error.code === 'ELOCKED') throw new Error('A bot process already uses this data directory, or a crashed process lock needs up to 60 seconds to expire.');
    throw error;
  }
}

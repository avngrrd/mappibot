import path from 'node:path';
import { open, readFile, writeFile } from 'node:fs/promises';

export function latestTunnelUrl(log) {
  let latest = '';
  for (const line of log.split(/\r?\n/)) {
    if (!line.includes('tunneled with tls termination')) continue;
    const host = /https:\/\/([a-z0-9][a-z0-9-]{0,62}\.(?:lhr\.life|localhost\.run))(?![a-zA-Z0-9.-])/.exec(line)?.[1];
    if (host && !/^(admin|www|api|ssh|docs)\./.test(host)) latest = `https://${host}`;
  }
  return latest;
}

/** Free localhost.run domains can rotate without the SSH process restarting. */
export async function readMapUrl(file) {
  let current = '';
  try { current = (await readFile(file, 'utf8')).trim(); } catch { /* Launcher still starting. */ }
  let handle;
  try {
    const directory = path.dirname(file);
    if ((await readFile(path.join(directory, 'tunnel-provider.txt'), 'utf8')).trim() !== 'localhost.run') return current;
    handle = await open(path.join(directory, 'tunnel.log'), 'r');
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, 128 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    const latest = latestTunnelUrl(buffer.subarray(0, bytesRead).toString('utf8'));
    if (latest && latest !== current) { await writeFile(file, latest, 'utf8'); current = latest; }
  } catch { /* Keep the last configured URL through log rotation or startup. */ }
  finally { await handle?.close(); }
  return current;
}

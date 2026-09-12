import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { latestTunnelUrl, readMapUrl } from '../src/tunnel-url.mjs';

test('uses the last real tunnel announcement, ignoring banners and lookalike domains', () => {
  assert.equal(latestTunnelUrl([
    'old.lhr.life tunneled with tls termination, https://old.lhr.life',
    'See https://admin.localhost.run/',
    'new.lhr.life tunneled with tls termination, https://new.lhr.life',
    'tunneled with tls termination, https://bad.lhr.life.attacker.example',
    'tunneled with tls termination, https://admin.localhost.run',
  ].join('\n')), 'https://new.lhr.life');
});

test('updates the persisted URL after a live SSH domain rotation; absent logs retain configured URL', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mappi-tunnel-'));
  try {
    const file = path.join(directory, 'map-url.txt');
    await writeFile(file, 'https://old.lhr.life');
    assert.equal(await readMapUrl(file), 'https://old.lhr.life');
    await writeFile(path.join(directory, 'tunnel-provider.txt'), 'localhost.run');
    await writeFile(path.join(directory, 'tunnel.log'), 'x'.repeat(140_000) + '\nnew.lhr.life tunneled with tls termination, https://new.lhr.life\n');
    assert.equal(await readMapUrl(file), 'https://new.lhr.life');
    assert.equal(await readFile(file, 'utf8'), 'https://new.lhr.life');
  } finally { await rm(directory, { recursive: true }); }
});

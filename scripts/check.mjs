import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function javascriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(path));
    else if (entry.isFile() && /\.m?js$/i.test(entry.name)) files.push(path);
  }
  return files;
}

const files = (await Promise.all(['src', 'web', 'scripts'].map(directory => javascriptFiles(join(root, directory))))).flat().sort();
let failures = 0;
for (const path of files) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', windowsHide: true });
  if (result.status === 0 && !result.error) continue;
  failures++;
  console.error(`Syntax check failed: ${relative(root, path)}`);
  console.error(result.stderr?.trim() || result.error?.message || `Node exited with status ${result.status}`);
}
if (failures) {
  console.error(`${failures} of ${files.length} JavaScript files failed syntax checks.`);
  process.exitCode = 1;
} else console.log(`Syntax checked ${files.length} JavaScript files.`);

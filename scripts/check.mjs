import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

for (const dir of ['api', 'worker', 'public', 'test', 'scripts']) {
  for (const name of readdirSync(new URL('../' + dir, import.meta.url)).filter(name => /\.(?:m?js)$/.test(name))) {
    const path = new URL('../' + dir + '/' + name, import.meta.url);
    const check = spawnSync(process.execPath, ['--check', decodeURIComponent(path.pathname)], { stdio: 'inherit' });
    if (check.status !== 0) process.exit(check.status ?? 1);
  }
}
console.log('Scout JavaScript syntax verified.');

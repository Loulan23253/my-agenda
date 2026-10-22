// Offline tests only: no credentials, real vault writes, or calendar network requests.
import esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(import.meta.url);
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'myagenda-tests-'));
let failed = false;
try {
  for (const name of ['selftest', ...Array.from({ length: 13 }, (_, i) => `selftest${i + 2}`), 'verify-audit']) {
    const entry = path.join(root, 'dev', `${name}.mts`);
    const outfile = path.join(output, `${name}.mjs`);
    await esbuild.build({
      entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile,
      alias: { obsidian: path.join(root, 'dev/obsidian-cjs-stub.cjs') },
      define: { 'import.meta.url': JSON.stringify(pathToFileURL(entry).href), 'import.meta.dirname': JSON.stringify(path.dirname(entry)) },
      plugins: [{ name: 'external-esbuild', setup(b) { b.onResolve({ filter: /^esbuild$/ }, () => ({ path: req.resolve('esbuild'), external: true })); } }],
      logLevel: 'silent',
    });
    const result = spawnSync(process.execPath, [outfile], { cwd: root, encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Shanghai' }, timeout: 30000 });
    const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    console.log(name, result.status === 0 ? log.split('\n').at(-1) : log);
    if (result.status !== 0) failed = true;
  }
} finally { fs.rmSync(output, { recursive: true, force: true }); }
if (failed) process.exit(1);

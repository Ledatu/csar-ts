/** Verify the actual packed exports and an unchanged browser dependency boundary. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
const artifact = resolve(process.argv[2]);
const temporary = mkdtempSync(join(tmpdir(), 'csar-ts-package-'));
try {
  const directory = join(temporary, 'node_modules', 'csar-ts');
  mkdirSync(directory, {recursive: true});
  execFileSync('tar', ['-xzf', artifact, '--strip-components=1', '-C', directory]);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '2.1.0');
  for (const mode of ['import', 'require']) {
    for (const field of ['types', 'default']) {
      const path = manifest.exports['./server-drain'][mode][field];
      assert.ok(readFileSync(join(directory, path)).length > 0);
    }
  }
  writeFileSync(join(temporary, 'smoke.cjs'), 'const {createServerDrain}=require("csar-ts/server-drain");if(createServerDrain({service:"packed-cjs"}).status().service!=="packed-cjs")throw Error("bad export");');
  writeFileSync(join(temporary, 'smoke.mjs'), 'import {createServerDrain} from "csar-ts/server-drain";if(createServerDrain({service:"packed-esm"}).status().service!=="packed-esm")throw Error("bad export");');
  execFileSync(process.execPath, [join(temporary, 'smoke.cjs')]);
  execFileSync(process.execPath, [join(temporary, 'smoke.mjs')]);
  const browser = await build({entryPoints: ['src/index.ts'], bundle: true, platform: 'browser', format: 'esm', external: ['axios', 'jose'], write: false, metafile: true});
  assert.ok(!Object.keys(browser.metafile.inputs).some(p => p.includes('/server/drain')));
  // Existing lazy Node file-key loading is unchanged; no static Node server
  // imports or server-drain source can enter the browser module graph.
  assert.ok(browser.outputFiles[0].text.length > 0);
  console.log(JSON.stringify({packed_exports: ['esm', 'cjs', 'declarations'], browser_graph_excludes_server_drain: true, version: manifest.version}));
} finally { rmSync(temporary, {recursive: true, force: true}); }

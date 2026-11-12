// Bundles the main thread and the UI, inlining the UI script into one HTML
// file because Figma loads `ui` as a single document.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'dist');
const tempDir = resolve(outDir, '.tmp');

async function bundle(entry, fileName) {
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    build: {
      outDir: tempDir,
      emptyOutDir: false,
      minify: true,
      target: 'es2020',
      lib: { entry: resolve(root, entry), formats: ['iife'], name: 'RangoliFigma', fileName: () => fileName },
    },
  });
  return readFile(resolve(tempDir, fileName), 'utf8');
}

await rm(outDir, { recursive: true, force: true });
await mkdir(tempDir, { recursive: true });

const code = await bundle('src/code.ts', 'code.js');
const uiScript = await bundle('src/ui/ui.ts', 'ui.js');
const template = await readFile(resolve(root, 'src/ui/ui.html'), 'utf8');

const placeholder = '/*__UI_BUNDLE__*/';
if (!template.includes(placeholder)) throw new Error('ui.html is missing the bundle placeholder');

// A literal "</script" inside the bundle would end the inline script early.
const safeScript = uiScript.replace(/<\/script/gi, '<\\/script');
const html = template.split(placeholder).join(safeScript);

await writeFile(resolve(outDir, 'code.js'), code);
await writeFile(resolve(outDir, 'ui.html'), html);
await rm(tempDir, { recursive: true, force: true });

console.log(`dist/code.js ${code.length} bytes, dist/ui.html ${html.length} bytes`);

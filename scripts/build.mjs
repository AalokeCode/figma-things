// Builds every plugin: src/code.ts -> dist/code.js; src/ui.ts + shared/ui.css inlined into dist/ui.html.
import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS = ['font-replacer', 'print', 'processor'];
const watch = process.argv.includes('--watch');

function writeUiHtml(dir, js) {
  const css = readFileSync(join(root, 'shared/ui.css'), 'utf8');
  const html = readFileSync(join(dir, 'src/ui.html'), 'utf8')
    .replace('/* @shared-css */', () => css)
    .replace('/* @ui-js */', () => js.replace(/<\/script/gi, '<\\/script'));
  writeFileSync(join(dir, 'dist/ui.html'), html);
}

async function contextsFor(name) {
  const dir = join(root, name);
  if (!existsSync(join(dir, 'manifest.json'))) throw new Error(`${name}: missing manifest.json`);
  mkdirSync(join(dir, 'dist'), { recursive: true });

  const code = await esbuild.context({
    entryPoints: [join(dir, 'src/code.ts')],
    bundle: true,
    target: 'es2017',
    outfile: join(dir, 'dist/code.js'),
    logLevel: 'warning',
  });
  const ui = await esbuild.context({
    entryPoints: [join(dir, 'src/ui.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2020',
    minify: !watch,
    outfile: join(dir, 'dist/ui.js'),
    logLevel: 'warning',
    plugins: [
      {
        name: 'inline-ui',
        setup(build) {
          build.onEnd((r) => {
            if (r.errors.length || !r.outputFiles) return;
            writeUiHtml(dir, r.outputFiles[0].text);
            console.log(`✓ ${name}`);
          });
        },
      },
    ],
  });
  return [code, ui];
}

const contexts = (await Promise.all(PLUGINS.map(contextsFor))).flat();
if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching…');
} else {
  try {
    await Promise.all(contexts.map((c) => c.rebuild()));
  } catch {
    process.exitCode = 1;
  } finally {
    await Promise.all(contexts.map((c) => c.dispose()));
  }
}

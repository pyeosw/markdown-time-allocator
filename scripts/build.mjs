import {build} from 'esbuild';
import {mkdir, copyFile, readFile, writeFile} from 'node:fs/promises';

await mkdir('artifacts', {recursive: true});
await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  sourcemap: true,
});
await build({
  entryPoints: ['webview/main.ts'],
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/webview.js',
});
await copyFile('webview/style.css', 'dist/webview.css');
// Include the complete license notices for every dependency in the runtime bundle.
const notices = await Promise.all(
  ['commonmark', 'entities', 'mdurl'].map(async name => {
    const directory = `node_modules/${name}`;
    const metadata = JSON.parse(
      await readFile(`${directory}/package.json`, 'utf8')
    );
    const license = await readFile(`${directory}/LICENSE`, 'utf8');
    return `${name} ${metadata.version}\n${'='.repeat(60)}\n${license}`;
  })
);
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n'), 'utf8');
await build({
  entryPoints: ['src/test/integration/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode', 'mocha'],
  outfile: 'out/integration/index.cjs',
});

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(root, 'public');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const name of ['index.html', 'style.css']) {
  await cp(resolve(root, name), resolve(out, name));
}
await cp(resolve(root, 'src'), resolve(out, 'src'), { recursive: true });
await writeFile(resolve(out, '.nojekyll'), '');

const html = await readFile(resolve(out, 'index.html'), 'utf8');
if (!html.includes('src/app.js') || !html.includes('style.css')) {
  throw new Error('Published HTML is missing its application assets.');
}
console.log('Built public/ with the static site only.');

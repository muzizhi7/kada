import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Rasterize only for post-run visual review; never changes trial artifacts.
const directory = resolve(process.argv[2]);
const deps = resolve(process.argv[3]);
const require = createRequire(join(deps, '_benchmark_render.cjs'));
const sharp = require('sharp');
const charts = ['sales-trend', 'share-trend', 'sales-vs-stock', 'scenarios-2027'];
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
for (const arm of manifest.order) {
  const target = join(directory, arm, 'assessment'); await mkdir(target, { recursive: true });
  const images = [];
  for (let i = 0; i < charts.length; i++) {
    const bytes = await sharp(join(directory, arm, 'workspace/deliverables/charts', charts[i] + '.svg')).resize(1100, 700, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
    await writeFile(join(target, charts[i] + '.png'), bytes);
    images.push({ input: bytes, left: (i % 2) * 1100, top: Math.floor(i / 2) * 700 });
  }
  await sharp({ create: { width: 2200, height: 1400, channels: 3, background: '#ffffff' } }).composite(images).png().toFile(join(target, 'charts.png'));
  console.log(JSON.stringify({ arm, preview: join(target, 'charts.png') }));
}

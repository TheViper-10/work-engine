// Bundle src/index.ts (and the engine from ../src) into dist/native.js. The SDK stays external: the platform provides it.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist'), { recursive: true });
const result = await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'dist/native.js'),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['@devrev/typescript-sdk', '@devrev/typescript-sdk/*'],
  logLevel: 'info',
  legalComments: 'none',
});
if (result.errors.length) process.exit(1);

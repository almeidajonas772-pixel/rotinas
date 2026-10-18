// Empacota a camada privada (server/node.ts) num único arquivo para `npm start`.
import { build } from 'esbuild';

await build({
  entryPoints: ['server/node.ts'],
  outfile: 'dist-server/node.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: false,
  logLevel: 'info',
});

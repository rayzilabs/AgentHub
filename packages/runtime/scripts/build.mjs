import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // 別名避免與被打包的模組自己 import 的 createRequire 撞名
  banner: { js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'info',
});

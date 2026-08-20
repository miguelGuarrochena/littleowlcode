import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli/cli.ts',
  },
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  dts: { entry: { index: 'src/index.ts' } },
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  banner: { js: '' },
  esbuildOptions(options) {
    options.banner = { js: '' };
  },
});

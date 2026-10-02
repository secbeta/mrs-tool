const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: test
    ? { extension: 'src/extension.ts', cli: 'src/cli.ts', run: 'test/unit/run.ts' }
    : { extension: 'src/extension.ts', cli: 'src/cli.ts' },
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outdir: test ? 'out' : 'dist',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  } else {
    await esbuild.build(options);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

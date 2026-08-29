require('esbuild').build({
  entryPoints: ['src/sidecar/index.ts'],
  bundle: true,
  outfile: 'dist/sidecar.js',
  platform: 'node',
  format: 'cjs',
  external: ['vscode', 'node-pty'],
  target: 'node20',
  sourcemap: false,
}).catch(() => process.exit(1));
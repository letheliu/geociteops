import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'

const sdkEntry = fileURLToPath(new URL('../sdk/src/index.ts', import.meta.url))

await esbuild.build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  packages: 'external',
  alias: {
    '@geociteops/sdk': sdkEntry,
  },
  legalComments: 'none',
  logLevel: 'info',
})

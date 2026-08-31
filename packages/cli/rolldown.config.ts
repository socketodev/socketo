import { defineConfig } from 'rolldown'

export default defineConfig({
  input: ['src/index.ts', 'src/worker.ts'],
  output: {
    dir: 'dist',
    format: 'esm',
    minify: true,
    cleanDir: true,
  },
  platform: 'node',
  external: ['ws'],
})

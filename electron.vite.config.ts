import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

// The app version, from package.json, available in code as __APP_VERSION__.
const define = { __APP_VERSION__: JSON.stringify(pkg.version) }

export default defineConfig({
  main: { define },
  preload: {},
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    define,
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') }
    }
  }
})

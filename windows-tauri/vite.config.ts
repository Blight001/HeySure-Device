import { defineConfig } from 'vite'

// Tauri expects a fixed dev-server port; `tauri dev` fails fast when it is taken.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  // Tauri injects env vars prefixed with TAURI_ during `tauri build`.
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2021',
    outDir: 'dist',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative asset URLs work both on GitHub Pages project URLs and a later custom domain.
  base: './',
  plugins: [react()],
  server: { port: 5300, host: true }
})

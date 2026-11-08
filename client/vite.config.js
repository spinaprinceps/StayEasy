import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In development the page is served by Vite (port 5173) and the API runs on port 3000.
// The proxy forwards /api/* to the API, so the browser only ever talks to ONE origin:
//   - no CORS setup needed on the server
//   - the "/api" prefix keeps API paths apart from page paths:
//     /hotels/32 is the PAGE, /api/hotels/32 is the DATA.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})

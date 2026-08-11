import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API is a separate origin in development. Proxying it means the
    // browser sees one origin, so the SameSite=Strict refresh cookie is sent —
    // which it would not be across origins, whatever CORS allowed.
    proxy: {
      '/auth': 'http://127.0.0.1:3000',
      '/clients': 'http://127.0.0.1:3000',
      '/loans': 'http://127.0.0.1:3000',
      '/loan-products': 'http://127.0.0.1:3000',
      '/payments': 'http://127.0.0.1:3000',
      '/reports': 'http://127.0.0.1:3000',
      '/finance': 'http://127.0.0.1:3000',
      '/reference': 'http://127.0.0.1:3000',
      '/statements': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000',
      '/ready': 'http://127.0.0.1:3000',
    },
  },
  build: {
    sourcemap: true,
  },
});

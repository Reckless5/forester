import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves the site under /<repo>/; locally it's /
  base: process.env.BASE_PATH ?? '/',
  // MapLibre runs its worker as an ES module
  worker: { format: 'es' },
});

import { defineConfig } from 'vite';

export default defineConfig({
  // itch.io serves games from a subdirectory inside an iframe, so all asset paths must be relative.
  base: './',
  // es2022 for top-level await (all current browsers).
  build: { target: 'es2022' },
  // the in-game credits import ../CREDITS.md (project root), so let the dev server read one level up
  server: { fs: { allow: ['..'] } },
});

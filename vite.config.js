import { defineConfig } from 'vite';

export default defineConfig({
    base: '/Little-Alchemist-Deck-Optimizer/',
    root: 'app',
    build: {
        outDir: '../dist',
        emptyOutDir: true,
    },
});

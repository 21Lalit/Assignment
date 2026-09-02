/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
    base: './',
    plugins: [react()],
    build: {
        sourcemap: true,
    },
    test: {
        environment: 'node',
        coverage: {
            reporter: ['text', 'html'],
        },
    },
});

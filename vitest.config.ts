import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.test.ts'],
        testTimeout: 30000, // 30s timeout for FFprobe tests
        hookTimeout: 60000, // 60s for setup/teardown
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            include: ['src/**/*.ts'],
            exclude: ['src/types.ts'],
        },
    },
});

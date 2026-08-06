import { defineConfig } from 'vitest/config';

/*
 * Backend / pipeline tests only.
 *
 * These must stay free, offline and deterministic so they can run constantly
 * and in CI. Two deliberate exclusions:
 *
 *  - src/app/**.spec.ts  -> Angular component tests. They need the Angular
 *                           test environment and run via `npm test` (ng test),
 *                           not through plain Vitest.
 *  - test/**.live.mjs    -> tests that call the real OpenAI API. They cost
 *                           money, so they live behind `npm run test:live`
 *                           and a separate config (vitest.live.config.mjs).
 *                           The `.live.mjs` suffix keeps them out of the
 *                           `*.test.mjs` glob automatically.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.mjs'],
    environment: 'node',
  },
});

import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

const migrations = await readD1Migrations('./migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          MAIN_BOT_TOKEN: '8606393164:TEST',
          ADMIN_BOT_TOKEN: '9000398776:TEST',
          ADMIN_IDS: '8406606797',
          CHANNEL_ID: '-1004416682870',
          CHANNEL_IDS: '-1004416682870,-1004374130055',
          WEBHOOK_SECRET: 'test-main-secret',
          ADMIN_WEBHOOK_SECRET: 'test-admin-secret',
          DIAG_KEY: 'test-diag-key',
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});

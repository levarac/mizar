import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test',
  use: { channel: 'chrome', baseURL: 'http://127.0.0.1:4178', viewport: { width: 1920, height: 1080 } },
  webServer: { command: 'node serve.mjs', port: 4178, reuseExistingServer: false },
});

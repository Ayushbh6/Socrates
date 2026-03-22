import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "PREMCHAT_FAKE_LLM=1 ../start-app.sh",
    cwd: __dirname,
    url: "http://127.0.0.1:3000/chat",
    reuseExistingServer: true,
    timeout: 180000,
  },
});

import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3010);

/**
 * Determinism tests run against the static dev build (npm run build:web-dev).
 * Multiplayer tests (tests/multiplayer.*) start their own server.
 */
export default defineConfig({
    testDir: "./tests",
    outputDir: "../test-results",
    timeout: 5 * 60_000,
    fullyParallel: true,
    workers: process.env.CI ? 2 : undefined,
    reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
    use: {
        baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`,
        viewport: { width: 1280, height: 800 },
        trace: "retain-on-failure",
        video: "retain-on-failure",
    },
    webServer: process.env.E2E_BASE_URL
        ? undefined
        : {
              command: `node static-server.mjs ../build_output/web-dev ${PORT}`,
              port: PORT,
              reuseExistingServer: !process.env.CI,
          },
    projects: [
        { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
        { name: "firefox", use: { ...devices["Desktop Firefox"], viewport: { width: 1280, height: 800 } } },
        { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } } },
    ],
});

import { defineConfig, devices } from "@playwright/test";

const braveExecutablePath = process.env.BRAVE_EXECUTABLE_PATH;

export default defineConfig({
	testDir: "./e2e",
	timeout: 60_000,
	expect: {
		timeout: 10_000,
	},
	fullyParallel: false,
	workers: 1, // Deterministic sequential DB state
	reporter: [
		["list"],
		["html", { open: "never", outputFolder: "playwright-report" }],
	],
	use: {
		baseURL: "http://localhost:8787",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		video: "off",
	},
	projects: [
		{
			name: "chromium-desktop",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1440, height: 900 },
				...(braveExecutablePath ? { launchOptions: { executablePath: braveExecutablePath } } : {}),
			},
		},
		{
			name: "chromium-mobile",
			use: {
				viewport: { width: 390, height: 844 },
				isMobile: true,
				hasTouch: true,
				userAgent:
					"Mozilla/5.0 (Linux; Android 13; REA-NX9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
			},
		},
	],
	webServer: {
		command: "node --import tsx e2e/helpers/start-test-server.ts",
		url: "http://127.0.0.1:8787/health",
		timeout: 120_000,
		reuseExistingServer: !process.env.CI,
		stdout: "pipe",
		stderr: "pipe",
	},
});

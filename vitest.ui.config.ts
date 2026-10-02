import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"@": resolve(__dirname, "frontend/src"),
			"virtual:pwa-register": resolve(
				__dirname,
				"frontend/tests/mocks/pwa-register.ts",
			),
		},
	},
	test: {
		environment: "jsdom",
		globals: true,
		setupFiles: ["./frontend/tests/setup.ts"],
		include: ["frontend/tests/**/*.test.{ts,tsx}"],
	},
});

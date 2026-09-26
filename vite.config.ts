import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: "frontend",
	plugins: [react()],
	resolve: {
		alias: {
			"@": resolve(__dirname, "frontend/src"),
		},
	},
	build: {
		outDir: resolve(__dirname, "dist"),
		emptyOutDir: true,
		sourcemap: true,
	},
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			"^/(health|ready|auth|budget-v2|credit-cards|transactions|manual-expenses|quick-entry|spending|people|short-term-goals|midas|long-term|income|month-close|imports|notifications|rewards|campaigns|ledger)":
				{
					target: "http://localhost:8787",
					changeOrigin: false,
				},
		},
	},
});

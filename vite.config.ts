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
	},
});

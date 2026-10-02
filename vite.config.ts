import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
	root: "frontend",
	plugins: [
		react(),
		VitePWA({
			registerType: "prompt",
			injectRegister: null, // We manage registration explicitly for update prompt & push coexistence
			filename: "sw.js",
			manifestFilename: "manifest.webmanifest",
			manifest: {
				name: "Gelir-Gider",
				short_name: "Gelir-Gider",
				lang: "tr",
				id: "/",
				start_url: "/",
				scope: "/",
				display: "standalone",
				theme_color: "#4f46e5",
				background_color: "#0f172a",
				icons: [
					{
						src: "/icons/icon-192x192.png",
						sizes: "192x192",
						type: "image/png",
						purpose: "any",
					},
					{
						src: "/icons/icon-512x512.png",
						sizes: "512x512",
						type: "image/png",
						purpose: "any",
					},
					{
						src: "/icons/icon-512x512-maskable.png",
						sizes: "512x512",
						type: "image/png",
						purpose: "maskable",
					},
				],
			},
			workbox: {
				clientsClaim: true,
				globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest}"],
				globIgnores: ["**/push-sw.js"],
				navigateFallback: "/index.html",
				navigateFallbackDenylist: [
					/^\/(health|ready|auth|budget-v2|credit-cards|transactions|manual-expenses|quick-entry|spending|people|short-term-goals|midas|long-term|income|month-close|imports|notifications|rewards|campaigns|ledger)($|\/)/,
					/^\/push-sw\.js$/,
					/^\/push\//,
				],
				runtimeCaching: [
					{
						urlPattern:
							/^\/(health|ready|auth|budget-v2|credit-cards|transactions|manual-expenses|quick-entry|spending|people|short-term-goals|midas|long-term|income|month-close|imports|notifications|rewards|campaigns|ledger)($|\/)/,
						handler: "NetworkOnly",
					},
				],
			},
		}),
	],
	resolve: {
		alias: {
			"@": resolve(__dirname, "frontend/src"),
		},
	},
	build: {
		manifest: true,
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

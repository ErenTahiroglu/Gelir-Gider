import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("PWA Manifest & Asset Structure (F10)", () => {
	const distPath = path.resolve(__dirname, "../../dist");
	const manifestPath = path.join(distPath, "manifest.webmanifest");

	it("manifest file exists and is valid JSON", () => {
		expect(
			fs.existsSync(manifestPath),
			`Manifest missing at ${manifestPath}. Run npm run build first.`,
		).toBe(true);

		const raw = fs.readFileSync(manifestPath, "utf-8");
		const manifest = JSON.parse(raw);

		expect(manifest.name).toBe("Gelir-Gider");
		expect(manifest.short_name).toBe("Gelir-Gider");
		expect(manifest.id).toBe("/");
		expect(manifest.start_url).toBe("/");
		expect(manifest.scope).toBe("/");
		expect(manifest.display).toBe("standalone");
		expect(manifest.theme_color).toBe("#4f46e5");
		expect(manifest.lang).toBe("tr");
	});

	it("contains required icons with correct purpose and sizes", () => {
		const raw = fs.readFileSync(manifestPath, "utf-8");
		const manifest = JSON.parse(raw);
		const icons = manifest.icons as Array<{
			src: string;
			sizes: string;
			type?: string;
			purpose?: string;
		}>;

		expect(Array.isArray(icons)).toBe(true);

		// 192x192 any
		const icon192 = icons.find(
			(i) =>
				i.sizes === "192x192" && (i.purpose?.includes("any") || !i.purpose),
		);
		expect(icon192).toBeDefined();

		// 512x512 any
		const icon512 = icons.find(
			(i) =>
				i.sizes === "512x512" && (i.purpose?.includes("any") || !i.purpose),
		);
		expect(icon512).toBeDefined();

		// 512x512 maskable
		const iconMaskable = icons.find(
			(i) => i.sizes === "512x512" && i.purpose?.includes("maskable"),
		);
		expect(iconMaskable).toBeDefined();

		// Verify files exist in dist
		for (const icon of icons) {
			const cleanSrc = icon.src.replace(/^\//, "");
			const iconFilePath = path.join(distPath, cleanSrc);
			expect(
				fs.existsSync(iconFilePath),
				`Icon file missing: ${iconFilePath}`,
			).toBe(true);
		}
	});

	it("verifies root sw.js and push-sw.js exist in dist", () => {
		const swPath = path.join(distPath, "sw.js");
		const pushSwPath = path.join(distPath, "push-sw.js");

		expect(
			fs.existsSync(swPath),
			`Root PWA service worker missing at ${swPath}`,
		).toBe(true);
		expect(
			fs.existsSync(pushSwPath),
			`F9 push service worker missing at ${pushSwPath}`,
		).toBe(true);
	});
});

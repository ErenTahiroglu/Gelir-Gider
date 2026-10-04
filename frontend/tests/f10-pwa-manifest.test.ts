import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

describe("PWA Manifest & Asset Structure (F10)", () => {
	const distPath = path.resolve(__dirname, "../../dist");
	const manifestPath = path.join(distPath, "manifest.webmanifest");

	beforeAll(() => {
		if (
			!fs.existsSync(manifestPath) ||
			!fs.existsSync(path.join(distPath, "sw.js"))
		) {
			execSync("npm run build", {
				cwd: path.resolve(__dirname, "../.."),
				stdio: "ignore",
			});
		}
	});

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
		// Approved brand identity — Navy 950
		expect(manifest.theme_color).toBe("#08111F");
		expect(manifest.background_color).toBe("#08111F");
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
		expect(icon192?.src).toBe("/icons/icon-192.png");

		// 512x512 any
		const icon512 = icons.find(
			(i) =>
				i.sizes === "512x512" && (i.purpose?.includes("any") || !i.purpose),
		);
		expect(icon512).toBeDefined();
		expect(icon512?.src).toBe("/icons/icon-512.png");

		// 192x192 maskable
		const iconMaskable192 = icons.find(
			(i) => i.sizes === "192x192" && i.purpose?.includes("maskable"),
		);
		expect(iconMaskable192).toBeDefined();
		expect(iconMaskable192?.src).toBe("/icons/maskable-192.png");

		// 512x512 maskable
		const iconMaskable512 = icons.find(
			(i) => i.sizes === "512x512" && i.purpose?.includes("maskable"),
		);
		expect(iconMaskable512).toBeDefined();
		expect(iconMaskable512?.src).toBe("/icons/maskable-512.png");

		// Both any and maskable purposes present
		const anyPurpose = icons.filter((i) => i.purpose?.includes("any"));
		const maskablePurpose = icons.filter((i) =>
			i.purpose?.includes("maskable"),
		);
		expect(anyPurpose.length).toBeGreaterThanOrEqual(2);
		expect(maskablePurpose.length).toBeGreaterThanOrEqual(2);

		// No legacy icon paths
		const legacyPaths = [
			"icon-192x192.png",
			"icon-512x512.png",
			"icon-512x512-maskable.png",
		];
		for (const icon of icons) {
			for (const legacy of legacyPaths) {
				expect(icon.src).not.toContain(legacy);
			}
		}

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

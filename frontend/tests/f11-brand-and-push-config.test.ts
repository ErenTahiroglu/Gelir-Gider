import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const source = path.join(root, "Logo", "gelir-gider-logo");
const publicDir = path.join(root, "frontend", "public");
const dist = path.join(root, "dist");
const configPath = path.join(root, "frontend", ".env.production");

function pngDimensions(file: string) {
	const bytes = fs.readFileSync(file);
	expect(bytes.subarray(0, 8)).toEqual(Buffer.from("89504e470d0a1a0a", "hex"));
	expect(bytes.toString("ascii", 12, 16)).toBe("IHDR");
	return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

beforeAll(() => {
	if (!fs.existsSync(path.join(dist, "manifest.webmanifest"))) {
		const result = spawnSync("npm", ["run", "build"], {
			cwd: root,
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
	}
});

describe("approved brand assets", () => {
	const svgNames = [
		"mark-dark-ui.svg",
		"mark-light-ui.svg",
		"mark-micro.svg",
		"mark-mono.svg",
		"lockup-dark-ui.svg",
		"lockup-light-ui.svg",
		"lockup-mono.svg",
	];

	for (const name of svgNames) {
		it(`serves the approved ${name}`, () => {
			const approved = fs.readFileSync(path.join(source, "svg", name));
			const served = fs.readFileSync(path.join(publicDir, "brand", name));
			expect(served).toEqual(approved);
			expect(fs.readFileSync(path.join(dist, "brand", name))).toEqual(approved);
		});
	}

	for (const [name, size] of [
		["icon-192.png", 192],
		["icon-512.png", 512],
		["maskable-192.png", 192],
		["maskable-512.png", 512],
	] as const) {
		it(`serves ${name} at ${size} × ${size}`, () => {
			const approved = fs.readFileSync(path.join(source, "png", name));
			expect(fs.readFileSync(path.join(publicDir, "icons", name))).toEqual(
				approved,
			);
			expect(fs.readFileSync(path.join(dist, "icons", name))).toEqual(approved);
			expect(pngDimensions(path.join(dist, "icons", name))).toEqual([
				size,
				size,
			]);
		});
	}

	it("serves the approved favicon and 180 × 180 Apple icon", () => {
		for (const name of ["favicon.svg", "favicon.ico"]) {
			const approved = fs.readFileSync(path.join(source, name));
			expect(fs.readFileSync(path.join(publicDir, name))).toEqual(approved);
			expect(fs.readFileSync(path.join(dist, name))).toEqual(approved);
		}
		const ico = fs.readFileSync(path.join(dist, "favicon.ico"));
		expect(ico.readUInt16LE(0)).toBe(0);
		expect(ico.readUInt16LE(2)).toBe(1);
		expect(ico.readUInt16LE(4)).toBeGreaterThan(0);
		expect(pngDimensions(path.join(dist, "apple-touch-icon.png"))).toEqual([
			180, 180,
		]);
	});

	it("manifest and HTML use the approved icon paths and colors", () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(dist, "manifest.webmanifest"), "utf8"),
		);
		expect(manifest.name).toBe("Gelir-Gider");
		expect(manifest.short_name).toBe("Gelir-Gider");
		expect(manifest.theme_color).toBe("#08111F");
		expect(manifest.background_color).toBe("#08111F");
		expect(manifest.icons).toEqual([
			{
				src: "/icons/icon-192.png",
				sizes: "192x192",
				type: "image/png",
				purpose: "any",
			},
			{
				src: "/icons/icon-512.png",
				sizes: "512x512",
				type: "image/png",
				purpose: "any",
			},
			{
				src: "/icons/maskable-192.png",
				sizes: "192x192",
				type: "image/png",
				purpose: "maskable",
			},
			{
				src: "/icons/maskable-512.png",
				sizes: "512x512",
				type: "image/png",
				purpose: "maskable",
			},
		]);
		const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
		expect(html).toContain('href="/favicon.ico"');
		expect(html).toContain('href="/favicon.svg"');
		expect(html).toContain('href="/apple-touch-icon.png"');
		expect(html).toContain('name="theme-color" content="#08111F"');
	});

	it("keeps design delivery files and legacy icons out of dist", () => {
		expect(fs.existsSync(path.join(dist, "Logo"))).toBe(false);
		expect(fs.existsSync(path.join(dist, "gelir-gider-logo.zip"))).toBe(false);
		for (const name of [
			"icon-192x192.png",
			"icon-512x512.png",
			"icon-512x512-maskable.png",
			"icon.svg",
		]) {
			expect(fs.existsSync(path.join(dist, "icons", name))).toBe(false);
		}
	});

	it("replaces the sidebar GG placeholder with theme-aware approved marks", () => {
		const sidebar = fs.readFileSync(
			path.join(root, "frontend/src/components/layout/DesktopSidebar.tsx"),
			"utf8",
		);
		expect(sidebar).not.toMatch(/>\s*GG\s*</);
		expect(sidebar).toContain("/brand/mark-light-ui.svg");
		expect(sidebar).toContain("/brand/mark-dark-ui.svg");
		const css = fs.readFileSync(
			path.join(root, "frontend/src/styles/global.css"),
			"utf8",
		);
		expect(css).toContain(':root:not([data-theme="light"]) .theme-brand-mark');
		expect(css).toContain('[data-theme="dark"] .theme-brand-mark');
	});
});

describe("durable public push configuration", () => {
	it("has exactly one valid public P-256 key assignment", () => {
		const match =
			/^VITE_WEB_PUSH_VAPID_PUBLIC_KEY=([A-Za-z0-9_-]+)\r?\n?$/.exec(
				fs.readFileSync(configPath, "utf8"),
			);
		expect(match).not.toBeNull();
		const key = match?.[1] ?? "";
		const decoded = Buffer.from(key, "base64url");
		expect(decoded.toString("base64url")).toBe(key);
		expect(decoded.length).toBe(65);
		expect(decoded[0]).toBe(0x04);
	});

	it("production JS contains the configured public key", () => {
		const key = /^VITE_WEB_PUSH_VAPID_PUBLIC_KEY=([^\r\n]+)/m.exec(
			fs.readFileSync(configPath, "utf8"),
		)?.[1];
		expect(key).toBeTruthy();
		const js = fs
			.readdirSync(path.join(dist, "assets"))
			.filter((name) => name.endsWith(".js"))
			.map((name) => fs.readFileSync(path.join(dist, "assets", name), "utf8"))
			.join("\n");
		expect(js.includes(key ?? "")).toBe(true);
		expect(js).toContain(
			"Bildirimler kapalı. İstediğiniz zaman etkinleştirebilirsiniz.",
		);
	});

	it("fails closed when the production config is missing", () => {
		const fixture = fs.mkdtempSync(
			path.join(os.tmpdir(), "push-config-check-"),
		);
		try {
			fs.mkdirSync(path.join(fixture, "scripts"));
			fs.mkdirSync(path.join(fixture, "frontend"));
			fs.copyFileSync(
				path.join(root, "scripts/check-public-push-config.mjs"),
				path.join(fixture, "scripts/check-public-push-config.mjs"),
			);
			const result = spawnSync(
				process.execPath,
				[path.join(fixture, "scripts/check-public-push-config.mjs")],
				{ encoding: "utf8" },
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("production config missing");
		} finally {
			fs.rmSync(fixture, { recursive: true, force: true });
		}
		const pkg = JSON.parse(
			fs.readFileSync(path.join(root, "package.json"), "utf8"),
		);
		expect(pkg.scripts.prebuild).toBe("npm run check:push-config");
	});

	it("contains no private VAPID assignment or other secret in frontend config", () => {
		const contents = fs.readFileSync(configPath, "utf8");
		for (const name of [
			"WEB_PUSH_VAPID_PRIVATE_KEY",
			"DATABASE_URL",
			"BACKUP_ENCRYPTION_KEY",
			"SESSION_SECRET",
		]) {
			expect(contents).not.toContain(name);
		}
	});
});

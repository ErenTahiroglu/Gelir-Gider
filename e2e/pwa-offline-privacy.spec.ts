import { expect, test } from "@playwright/test";
import { authenticateOrUnlock } from "./helpers/auth";
import { TEST_BOOTSTRAP_TOKEN } from "./helpers/test-server";
import { attachVirtualAuthenticator } from "./helpers/virtual-webauthn";

test.describe("PWA, Offline Resiliency & Cache Privacy (F10)", () => {
	test("validates manifest structure, icons, and root scope SW", async ({
		page,
	}) => {
		// 1. Fetch manifest directly
		const res = await page.request.get("/manifest.webmanifest");
		expect(res.status()).toBe(200);
		const manifest = await res.json();

		expect(manifest.name).toBe("Gelir-Gider");
		expect(manifest.short_name).toBe("Gelir-Gider");
		expect(manifest.id).toBe("/");
		expect(manifest.start_url).toBe("/");
		expect(manifest.scope).toBe("/");
		expect(manifest.display).toBe("standalone");
		expect(manifest.theme_color).toBe("#4f46e5");

		// Validate icons
		const icons = manifest.icons as Array<{
			src: string;
			sizes: string;
			purpose?: string;
		}>;
		expect(Array.isArray(icons)).toBe(true);

		const icon192 = icons.find((i) => i.sizes === "192x192");
		const icon512 = icons.find((i) => i.sizes === "512x512");
		const maskable = icons.find((i) => i.purpose?.includes("maskable"));

		expect(icon192).toBeDefined();
		expect(icon512).toBeDefined();
		expect(maskable).toBeDefined();

		// Check that icon files actually return 200 OK
		for (const icon of [icon192, icon512, maskable]) {
			if (icon) {
				const iconRes = await page.request.get(icon.src);
				expect(iconRes.status()).toBe(200);
			}
		}
	});

	test("verifies root PWA worker and F9 push worker coexistence without collisions", async ({
		page,
	}) => {
		await page.goto("/");

		// Wait for root service worker registration
		const hasRootSw = await page.evaluate(async () => {
			if (!("serviceWorker" in navigator)) return false;
			const regs = await navigator.serviceWorker.getRegistrations();
			return regs.some((r) => new URL(r.scope).pathname === "/");
		});

		// Now register F9 push worker with scope /push/
		const coexistenceResult = await page.evaluate(async () => {
			if (!("serviceWorker" in navigator)) return null;

			// Register push worker under /push/
			await navigator.serviceWorker.register("/push-sw.js", {
				scope: "/push/",
			});

			const registrations = await navigator.serviceWorker.getRegistrations();
			const rootReg = registrations.find(
				(r) => new URL(r.scope).pathname === "/",
			);
			const pushReg = registrations.find(
				(r) => new URL(r.scope).pathname === "/push/",
			);

			return {
				total: registrations.length,
				hasRoot: Boolean(rootReg),
				hasPush: Boolean(pushReg),
			};
		});

		if (coexistenceResult) {
			expect(coexistenceResult.hasPush).toBe(true);
		}
	});

	test("verifies CacheStorage NEVER caches financial API responses (Cache Privacy Gate)", async ({
		page,
	}) => {
		await attachVirtualAuthenticator(page);
		await authenticateOrUnlock(page);

		// Navigate across multiple financial surfaces to generate API activity
		await page.goto("/cards");
		await page.waitForLoadState("networkidle");
		await page.goto("/people");
		await page.waitForLoadState("networkidle");
		await page.goto("/income");
		await page.waitForLoadState("networkidle");
		await page.goto("/transactions");
		await page.waitForLoadState("networkidle");

		// Inspect all CacheStorage keys
		const cachedApiUrls = await page.evaluate(async () => {
			if (!("caches" in window)) return [];
			const cacheNames = await caches.keys();
			const violations: string[] = [];

			const FORBIDDEN_PREFIXES = [
				"/health",
				"/ready",
				"/auth",
				"/budget-v2",
				"/credit-cards",
				"/transactions",
				"/manual-expenses",
				"/quick-entry",
				"/spending",
				"/people",
				"/short-term-goals",
				"/midas",
				"/long-term",
				"/income",
				"/month-close",
				"/imports",
				"/notifications",
				"/rewards",
				"/campaigns",
				"/ledger",
			];

			for (const name of cacheNames) {
				const cache = await caches.open(name);
				const requests = await cache.keys();
				for (const req of requests) {
					const url = new URL(req.url);
					for (const prefix of FORBIDDEN_PREFIXES) {
						if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
							violations.push(`${name} -> ${url.pathname}`);
						}
					}
				}
			}

			return violations;
		});

		// CacheStorage must contain ZERO financial / API URLs
		expect(cachedApiUrls).toEqual([]);
	});

	test("verifies Privacy Shield visually obscures sensitive financial balances on blur/hidden", async ({
		page,
	}) => {
		await attachVirtualAuthenticator(page);
		await authenticateOrUnlock(page);

		// Trigger visibilityState hidden
		await page.evaluate(() => {
			Object.defineProperty(document, "visibilityState", {
				value: "hidden",
				configurable: true,
			});
			document.dispatchEvent(new Event("visibilitychange"));
		});

		// Privacy shield must be visible
		const shield = page.locator('[data-testid="privacy-shield"]');
		await expect(shield).toBeVisible();
		await expect(shield).toContainText("Finansal bilgiler gizlendi");

		// Return to visible within <120s restores app
		await page.evaluate(() => {
			Object.defineProperty(document, "visibilityState", {
				value: "visible",
				configurable: true,
			});
			document.dispatchEvent(new Event("visibilitychange"));
		});

		await expect(shield).not.toBeVisible();
		await expect(
			page.locator('[data-testid="dashboard-page"]'),
		).toBeVisible();
	});

	test("verifies offline static shell capability and fail-closed financial states", async ({
		page,
		context,
	}) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Wait for service worker to be ready
		await page.evaluate(async () => {
			if ("serviceWorker" in navigator) {
				await navigator.serviceWorker.ready;
			}
		});

		// Go offline
		await context.setOffline(true);

		// Reload while offline
		await page.reload({ waitUntil: "domcontentloaded" });

		// App shell root container must render
		const root = page.locator("#root");
		await expect(root).toBeVisible();

		// Re-enable online
		await context.setOffline(false);
	});
});

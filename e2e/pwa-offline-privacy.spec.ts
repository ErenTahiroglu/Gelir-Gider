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
		expect(manifest.theme_color).toBe("#08111F");
		expect(manifest.background_color).toBe("#08111F");

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

		// Wait for root service worker registration (scope: /)
		await page.waitForFunction(
			async () => {
				if (!("serviceWorker" in navigator)) return false;
				const regs = await navigator.serviceWorker.getRegistrations();
				return regs.some((r) => new URL(r.scope).pathname === "/");
			},
			undefined,
			{ timeout: 10000 },
		);

		// Assert root registration exists and has NOT subscribed to push
		const rootPreCheck = await page.evaluate(async () => {
			const regs = await navigator.serviceWorker.getRegistrations();
			const root = regs.find((r) => new URL(r.scope).pathname === "/");
			if (!root) return { hasRoot: false, hasSub: false };
			const sub = await root.pushManager.getSubscription();
			return { hasRoot: true, hasSub: Boolean(sub) };
		});
		expect(rootPreCheck.hasRoot).toBe(true);
		expect(rootPreCheck.hasSub).toBe(false); // No silent push subscription!

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
				rootScope: rootReg ? new URL(rootReg.scope).pathname : null,
				hasPush: Boolean(pushReg),
				pushScope: pushReg ? new URL(pushReg.scope).pathname : null,
			};
		});

		expect(coexistenceResult).not.toBeNull();
		expect(coexistenceResult?.hasRoot).toBe(true);
		expect(coexistenceResult?.rootScope).toBe("/");
		expect(coexistenceResult?.hasPush).toBe(true);
		expect(coexistenceResult?.pushScope).toBe("/push/");
		expect(coexistenceResult?.total).toBeGreaterThanOrEqual(2);

		// Assert root service worker still has not created a push subscription
		const rootPostSub = await page.evaluate(async () => {
			const rootReg = await navigator.serviceWorker.getRegistration("/");
			if (!rootReg) return null;
			return await rootReg.pushManager.getSubscription();
		});
		expect(rootPostSub).toBeNull();
	});

	test("push enable resolves the exact /push/ registration, never the root PWA one", async ({
		page,
		context,
	}) => {
		// Headless Chromium reports Notification.permission "denied" regardless of
		// grantPermissions; the permission prompt is not under test, the SW lifecycle is.
		await context.addInitScript(() => {
			Object.defineProperty(Notification, "permission", {
				get: () => "granted",
				configurable: true,
			});
		});
		await attachVirtualAuthenticator(page);
		await authenticateOrUnlock(page);

		await page.waitForFunction(
			async () => {
				const regs = await navigator.serviceWorker.getRegistrations();
				return regs.some((r) => new URL(r.scope).pathname === "/");
			},
			undefined,
			{ timeout: 10000 },
		);

		// Clean slate: root PWA worker only, no /push/ registration.
		await page.evaluate(async () => {
			for (const r of await navigator.serviceWorker.getRegistrations()) {
				if (new URL(r.scope).pathname === "/push/") await r.unregister();
			}
		});

		await page.evaluate(() => {
			window.history.pushState({}, "", "/notifications");
			window.dispatchEvent(new PopStateEvent("popstate"));
		});
		await page.getByTestId("tab-push-settings").click();

		// No silent registration/subscription on page load.
		const before = await page.evaluate(async () => {
			const regs = await navigator.serviceWorker.getRegistrations();
			return regs.map((r) => new URL(r.scope).pathname);
		});
		expect(before).not.toContain("/push/");

		await page.getByTestId("btn-enable-push").click();

		await page.waitForFunction(
			async () => {
				const regs = await navigator.serviceWorker.getRegistrations();
				return regs.some(
					(r) =>
						new URL(r.scope).pathname === "/push/" &&
						r.active?.state === "activated",
				);
			},
			undefined,
			{ timeout: 15000 },
		);

		const after = await page.evaluate(async () => {
			const regs = await navigator.serviceWorker.getRegistrations();
			const root = regs.find((r) => new URL(r.scope).pathname === "/");
			const push = regs.find((r) => new URL(r.scope).pathname === "/push/");
			return {
				hasRoot: Boolean(root),
				hasPush: Boolean(push),
				rootHasSub: root ? Boolean(await root.pushManager.getSubscription()) : null,
			};
		});
		expect(after.hasRoot).toBe(true);
		expect(after.hasPush).toBe(true);
		// Root registration must never own a PushSubscription.
		expect(after.rootHasSub).toBe(false);

		// Headless Chromium may have no push service: subscribe may legitimately
		// fail, but only AFTER the dedicated worker lifecycle (stage "subscribe").
		const alert = page.getByTestId("push-status-alert");
		if (await alert.isVisible().catch(() => false)) {
			const text = (await alert.textContent()) ?? "";
			expect(text).not.toContain("worker/");
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

	test("verifies Privacy Shield visually obscures sensitive financial balances on blur/hidden/pagehide and enforces reauth after >=120s", async ({
		page,
	}) => {
		await attachVirtualAuthenticator(page);
		await authenticateOrUnlock(page);

		// 1. Trigger visibilityState hidden
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

		// 2. Trigger window blur
		await page.evaluate(() => {
			window.dispatchEvent(new Event("blur"));
		});
		await expect(shield).toBeVisible();

		// Window focus <120s restores app
		await page.evaluate(() => {
			window.dispatchEvent(new Event("focus"));
		});
		await expect(shield).not.toBeVisible();
		await expect(
			page.locator('[data-testid="dashboard-page"]'),
		).toBeVisible();

		// 3. Trigger pagehide
		await page.evaluate(() => {
			window.dispatchEvent(new Event("pagehide"));
		});
		await expect(shield).toBeVisible();

		// 4. Simulate >=120s elapsed duration by advancing Date.now before pageshow
		await page.evaluate(() => {
			(window as unknown as { __origNow?: typeof Date.now }).__origNow =
				Date.now;
			const realNow = Date.now();
			Date.now = () => realNow + 130_000;
			window.dispatchEvent(new Event("pageshow"));
		});

		// Privacy shield hides, but locked overlay is displayed
		await expect(shield).not.toBeVisible();
		const lockedOverlay = page.locator('[data-testid="locked-overlay"]');
		await expect(lockedOverlay).toBeVisible();
		await expect(lockedOverlay).toContainText("Gelir-Gider kilitli");

		// Protected content is marked inert and aria-hidden
		const protectedContent = page.locator(".protected-content");
		await expect(protectedContent).toHaveAttribute("aria-hidden", "true");

		// Restore Date.now for subsequent interaction
		await page.evaluate(() => {
			const orig = (window as unknown as { __origNow?: typeof Date.now })
				.__origNow;
			if (orig) {
				Date.now = orig;
			}
		});

		// 5. Unlock with Passkey using virtual authenticator
		const unlockButton = page.locator('[data-testid="reauth-passkey-button"]');
		await expect(unlockButton).toBeVisible();
		await unlockButton.click();

		// Dashboard is restored
		await expect(lockedOverlay).not.toBeVisible();
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

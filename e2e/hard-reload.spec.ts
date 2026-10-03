import { expect, test } from "@playwright/test";
import { authenticateOrUnlock } from "./helpers/auth";
import { attachVirtualAuthenticator } from "./helpers/virtual-webauthn";

/**
 * PLAYWRIGHT HARD-RELOAD & DIRECT NAVIGATION MATRIX
 *
 * Verifies that top-level browser document navigations (`page.goto(url)`)
 * and hard reloads (`page.reload()`) to all major SPA routes return the
 * application HTML shell (never backend JSON 404/401) and properly render
 * the corresponding UI surfaces after authentication across desktop and mobile.
 */

interface HardReloadTarget {
	path: string;
	surfaceSelector: string;
	name: string;
}

const HARD_RELOAD_ROUTES: HardReloadTarget[] = [
	{ path: "/", surfaceSelector: '[data-testid="dashboard-page"]', name: "Dashboard" },
	{ path: "/transactions", surfaceSelector: '[data-testid="transaction-timeline"]', name: "Transactions" },
	{ path: "/cards", surfaceSelector: '[data-testid="cards-page"]', name: "Cards" },
	{ path: "/people", surfaceSelector: '[data-testid="people-page"]', name: "People" },
	{ path: "/midas", surfaceSelector: '[data-testid="midas-page"], [data-testid="midas-page-setup"]', name: "Midas" },
	{ path: "/goals", surfaceSelector: '[data-testid="goals-page"]', name: "Goals" },
	{ path: "/long-term", surfaceSelector: '[data-testid="long-term-page"]', name: "Long-Term" },
	{ path: "/income", surfaceSelector: '[data-testid="income-page"]', name: "Income" },
	{ path: "/month-close", surfaceSelector: '[data-testid="month-close-page"]', name: "Month Close" },
	{ path: "/imports", surfaceSelector: '[data-testid="imports-page"]', name: "Imports" },
	{ path: "/notifications", surfaceSelector: '[data-testid="notifications-page"]', name: "Notifications" },
	{ path: "/settings/devices", surfaceSelector: '[data-testid="device-management-page"]', name: "Device Management" },
];

test.describe("Hard-Reload & Direct URL Navigation Matrix", () => {
	test.beforeEach(async ({ page }) => {
		await attachVirtualAuthenticator(page);
	});

	test("verifies all 12 major routes survive hard goto() and reload() without JSON NOT_FOUND", async ({
		page,
	}) => {
		test.setTimeout(180_000);

		// Observability listeners
		const pageErrors: string[] = [];
		page.on("pageerror", (err) => {
			pageErrors.push(`[PAGE_ERROR] ${err.message}`);
		});

		// 1. Authenticate once to establish session
		await authenticateOrUnlock(page);

		// Helper to ensure unlock if prompted by passkey gate
		async function handlePossibleUnlock() {
			const unlockBtn = page
				.locator(
					'[data-testid="unlock-passkey-button"], [data-testid="reauth-passkey-button"]',
				)
				.first();
			if (await unlockBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
				await unlockBtn.click();
			}
		}

		// 2. Iterate through all major routes using direct page.goto() and page.reload()
		for (const target of HARD_RELOAD_ROUTES) {
			// A. Hard URL Navigation (page.goto)
			const response = await page.goto(target.path, { waitUntil: "domcontentloaded" });
			expect(response, `Response for ${target.path} must exist`).not.toBeNull();
			expect(
				response?.status(),
				`Direct navigation to ${target.path} must return HTTP 200`,
			).toBe(200);

			const contentType = response?.headers()["content-type"] ?? "";
			expect(
				contentType,
				`Direct navigation to ${target.path} must return text/html, not application/json`,
			).toContain("text/html");

			// Handle passkey unlock if reauth gate prompted
			await handlePossibleUnlock();

			// Ensure target UI surface renders
			const surface = page.locator(target.surfaceSelector).first();
			await expect(
				surface,
				`Surface for ${target.name} (${target.path}) must be visible after hard goto()`,
			).toBeVisible({ timeout: 15000 });

			// Verify no backend JSON error is displayed
			const bodyText = await page.locator("body").innerText();
			expect(
				bodyText,
				`Route ${target.path} must never display Route not found JSON`,
			).not.toContain('"Route not found"');
			expect(bodyText).not.toContain('"NOT_FOUND"');

			// B. Hard Reload (simulates PWA update activation / user browser reload)
			const reloadResponse = await page.reload({ waitUntil: "domcontentloaded" });
			expect(reloadResponse?.status()).toBe(200);
			expect(reloadResponse?.headers()["content-type"] ?? "").toContain("text/html");

			await handlePossibleUnlock();

			await expect(
				surface,
				`Surface for ${target.name} (${target.path}) must remain visible after reload()`,
			).toBeVisible({ timeout: 15000 });

			const reloadedBodyText = await page.locator("body").innerText();
			expect(reloadedBodyText).not.toContain('"Route not found"');
			expect(reloadedBodyText).not.toContain('"NOT_FOUND"');
		}

		expect(pageErrors, "No fatal uncaught page errors during hard reloads").toEqual([]);
	});

	test("Section 10 PWA update regression: application on /notifications survives update reload without backend NOT_FOUND", async ({
		page,
	}) => {
		test.setTimeout(60_000);

		const pageErrors: string[] = [];
		page.on("pageerror", (err) => {
			pageErrors.push(`[PAGE_ERROR] ${err.message}`);
		});

		// 1. Authenticate and reach Dashboard
		await authenticateOrUnlock(page);

		async function handlePossibleUnlock() {
			const unlockBtn = page
				.locator(
					'[data-testid="unlock-passkey-button"], [data-testid="reauth-passkey-button"]',
				)
				.first();
			if (await unlockBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
				await unlockBtn.click();
			}
		}

		// 2. Application is on /notifications
		const notifNavResponse = await page.goto("/notifications", {
			waitUntil: "domcontentloaded",
		});
		expect(notifNavResponse?.status()).toBe(200);
		expect(notifNavResponse?.headers()["content-type"] ?? "").toContain("text/html");

		await handlePossibleUnlock();

		const notifSurface = page.locator('[data-testid="notifications-page"]').first();
		await expect(notifSurface).toBeVisible({ timeout: 15000 });

		// 3. Update/new service worker is available -> reload/update activation occurs
		// (In production, user clicks 'Şimdi Yenile' in PwaUpdatePrompt which triggers reload)
		const reloadResponse = await page.reload({ waitUntil: "domcontentloaded" });
		expect(reloadResponse?.status()).toBe(200);
		expect(reloadResponse?.headers()["content-type"] ?? "").toContain("text/html");

		await handlePossibleUnlock();

		// 4. App returns to Notifications page
		await expect(notifSurface).toBeVisible({ timeout: 15000 });

		// 5. Backend JSON NOT_FOUND is never displayed
		const bodyText = await page.locator("body").innerText();
		expect(bodyText).not.toContain('"Route not found"');
		expect(bodyText).not.toContain('"NOT_FOUND"');
		expect(pageErrors).toEqual([]);
	});
});

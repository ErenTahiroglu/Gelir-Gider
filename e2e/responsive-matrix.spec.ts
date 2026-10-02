import { expect, test } from "@playwright/test";
import { authenticateOrUnlock } from "./helpers/auth";
import { attachVirtualAuthenticator } from "./helpers/virtual-webauthn";

interface RouteAuditTarget {
	path: string;
	surfaceSelector: string;
	name: string;
}

const MAJOR_ROUTES: RouteAuditTarget[] = [
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
];

test.describe("Complete Responsive Major-Route Matrix & Observability (F10)", () => {
	test.beforeEach(async ({ page }) => {
		await attachVirtualAuthenticator(page);
	});

	test("audits all 11 major routes and Quick Entry across viewports for rendering, overflow, and network health", async ({
		page,
	}, testInfo) => {
		const isMobile = testInfo.project.name === "chromium-mobile";

		// Observability listeners
		const pageErrors: string[] = [];
		const consoleErrors: string[] = [];
		const failedInitialRequests: string[] = [];

		page.on("pageerror", (err) => {
			pageErrors.push(`[PAGE_ERROR] ${err.message}`);
		});

		page.on("console", (msg) => {
			if (msg.type() === "error") {
				const text = msg.text();
				if (
					!text.includes("favicon.ico") &&
					!text.includes("Failed to load resource: the server responded with a status of 404")
				) {
					consoleErrors.push(text);
				}
			}
		});

		page.on("response", (res) => {
			const url = res.url();
			if (res.status() >= 500) {
				failedInitialRequests.push(`[HTTP_5XX] ${res.status()} ${url}`);
			}
			// Targeted check: /income/receipts must not fail with 400
			if (url.includes("/income/receipts") && res.status() >= 400) {
				failedInitialRequests.push(`[INCOME_RECEIPTS_FAIL] ${res.status()} ${url}`);
			}
		});

		// 1. Authenticate and reach Dashboard
		await authenticateOrUnlock(page);

		// Helper to navigate via SPA pushState to prevent full page re-enrollment
		async function navigateSPA(path: string) {
			await page.evaluate((targetUrl: string) => {
				window.history.pushState({}, "", targetUrl);
				window.dispatchEvent(new PopStateEvent("popstate"));
			}, path);

			const unlockBtn = page
				.locator(
					'[data-testid="unlock-passkey-button"], [data-testid="reauth-passkey-button"]',
				)
				.first();
			if (await unlockBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
				await unlockBtn.click();
			}
			await page.waitForLoadState("networkidle");
		}

		// Track income query success explicitly
		let incomeReceiptsQueryPassed = false;
		page.on("response", (res) => {
			if (res.url().includes("/income/receipts") && res.status() === 200) {
				incomeReceiptsQueryPassed = true;
			}
		});

		// 2. Audit every major route in the matrix
		for (const target of MAJOR_ROUTES) {
			await navigateSPA(target.path);

			const surface = page.locator(target.surfaceSelector).first();
			try {
				await expect(surface).toBeVisible({ timeout: 15000 });
			} catch (e) {
				const showErrorBtn = page.locator('button:has-text("Show Error")');
				if (await showErrorBtn.isVisible().catch(() => false)) {
					await showErrorBtn.click();
					const pre = await page.locator("pre").allInnerTexts();
					console.error(`[REACT_ERROR_ON_${target.name}]`, pre.join("\n"));
				}
				throw e;
			}

			// Assert error screen is NOT rendered instead of content
			const fatalAlert = page.locator('[data-testid="fatal-auth-screen"], .fatal-error, [role="alert"].error');
			if (await fatalAlert.isVisible().catch(() => false)) {
				const text = await fatalAlert.innerText();
				throw new Error(`Route ${target.path} displayed error screen: ${text}`);
			}

			// Assert no unintended page-level horizontal overflow
			const overflow = await page.evaluate(() => {
				return {
					scrollWidth: document.documentElement.scrollWidth,
					clientWidth: document.documentElement.clientWidth,
					hasOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
				};
			});
			expect(
				overflow.hasOverflow,
				`Route ${target.name} (${target.path}) has horizontal overflow: scrollWidth ${overflow.scrollWidth} > clientWidth ${overflow.clientWidth}`,
			).toBe(false);
		}

		// Assert /income receipts query succeeded
		expect(
			incomeReceiptsQueryPassed,
			"Expected GET /income/receipts query to have succeeded with 200 on /income route audit",
		).toBe(true);

		// 3. Audit Quick Entry in opened state
		const quickEntryBtn = page
			.locator(
				'[data-testid="mobile-quick-entry-fab"], [data-testid="desktop-quick-entry-btn"]',
			)
			.first();
		await expect(quickEntryBtn).toBeVisible();
		await quickEntryBtn.click();

		const quickEntrySheet = page.locator('[data-testid="quick-entry-sheet"]');
		await expect(quickEntrySheet).toBeVisible();

		// Verify primary controls inside Quick Entry are not obscured
		const cashBtn = page.locator('[data-testid="quick-entry-cash-btn"]');
		await expect(cashBtn).toBeVisible();
		await expect(cashBtn).toBeEnabled();

		// Check overflow with Quick Entry open
		const quickEntryOverflow = await page.evaluate(() => {
			return document.documentElement.scrollWidth > document.documentElement.clientWidth;
		});
		expect(quickEntryOverflow, "Quick Entry opened state must not cause page-level horizontal overflow").toBe(false);

		// Close Quick Entry sheet
		const closeBtn = page.locator('[data-testid="quick-entry-close-btn"]');
		if (await closeBtn.isVisible().catch(() => false)) {
			await closeBtn.click();
		} else {
			await page.keyboard.press("Escape");
		}
		await expect(quickEntrySheet).not.toBeVisible();

		// 4. Viewport-specific structural audits
		if (isMobile) {
			// Mobile bottom nav must have exactly 5 slots
			const mobileBottomNav = page.locator('[data-testid="mobile-bottom-nav"]');
			await expect(mobileBottomNav).toBeVisible();

			const navSlotsCount = await page.evaluate(() => {
				const inner = document.querySelector(".mobile-nav-inner");
				return inner ? inner.children.length : 0;
			});
			expect(navSlotsCount, "Mobile bottom nav must have exactly 5 slots").toBe(5);

			// Center + FAB must be visible and central
			const fab = page.locator('[data-testid="mobile-quick-entry-fab"]');
			await expect(fab).toBeVisible();
			const fabBox = await fab.boundingBox();
			expect(fabBox).not.toBeNull();
			if (fabBox) {
				// 390 width viewport: center is 195. FAB center should be close to 195 (+/- 25px)
				const fabCenterX = fabBox.x + fabBox.width / 2;
				expect(Math.abs(fabCenterX - 195)).toBeLessThan(30);
			}
		} else {
			// Desktop sidebar must be visible, usable, and collapsible
			const sidebar = page.locator('[data-testid="desktop-sidebar"]');
			await expect(sidebar).toBeVisible();
			await expect(sidebar).toHaveClass(/expanded/);

			const toggleBtn = page.locator('[data-testid="sidebar-toggle-btn"]');
			await expect(toggleBtn).toBeVisible();

			// Collapse sidebar
			await toggleBtn.click();
			await expect(sidebar).toHaveClass(/collapsed/);

			// Expand sidebar again
			await toggleBtn.click();
			await expect(sidebar).toHaveClass(/expanded/);
		}

		// Observability final assertions
		expect(pageErrors, `Page errors encountered: ${pageErrors.join(", ")}`).toEqual([]);
		expect(consoleErrors, `Unexpected console errors encountered: ${consoleErrors.join(", ")}`).toEqual([]);
		expect(failedInitialRequests, `Failed network requests encountered: ${failedInitialRequests.join(", ")}`).toEqual([]);
	});
});

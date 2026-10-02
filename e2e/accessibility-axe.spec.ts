import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { authenticateOrUnlock } from "./helpers/auth";
import { TEST_BOOTSTRAP_TOKEN } from "./helpers/test-server";
import { attachVirtualAuthenticator } from "./helpers/virtual-webauthn";

test.describe("WCAG 2.2 AA Accessibility Audits via Axe (F10)", () => {
	test.beforeEach(async ({ page }) => {
		await attachVirtualAuthenticator(page);
		await page.request.post("/__test_reset_db__");
	});

	test("audits critical surfaces for 0 axe violations (WCAG 2.2 AA)", async ({
		page,
	}) => {
		// 1. Audit Unlock / Bootstrap screen
		await page.goto("/");
		await expect(page.locator("body")).toBeVisible();

		const unlockAxe = await new AxeBuilder({ page })
			.withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
			.analyze();
		expect(unlockAxe.violations).toEqual([]);

		// Complete enrollment if needed to unlock the rest of the application
		await authenticateOrUnlock(page);

		async function navigateSPA(targetUrl: string) {
			await page.evaluate((url: string) => {
				window.history.pushState({}, "", url);
				window.dispatchEvent(new PopStateEvent("popstate"));
			}, targetUrl);
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

		// 2. Audit Dashboard
		const dashboardAxe = await new AxeBuilder({ page })
			.withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
			.analyze();
		expect(dashboardAxe.violations).toEqual([]);

		// 3. Audit Transactions
		await navigateSPA("/transactions");
		const txAxe = await new AxeBuilder({ page })
			.withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
			.analyze();
		expect(txAxe.violations).toEqual([]);

		// 4. Audit Cards
		await navigateSPA("/cards");
		const cardsAxe = await new AxeBuilder({ page })
			.withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
			.analyze();
		expect(cardsAxe.violations).toEqual([]);

		// 5. Audit People
		await navigateSPA("/people");
		const peopleAxe = await new AxeBuilder({ page })
			.withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
			.analyze();
		expect(peopleAxe.violations).toEqual([]);

		// 6. Audit Income
		await navigateSPA("/income");
		const incomeAxe = await new AxeBuilder({ page })
			.withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
			.analyze();
		expect(incomeAxe.violations).toEqual([]);

		// 7. Audit Month Close
		await navigateSPA("/month-close");
		const monthCloseAxe = await new AxeBuilder({ page })
			.withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
			.analyze();
		expect(monthCloseAxe.violations).toEqual([]);

		// 8. Audit Imports
		await navigateSPA("/imports");
		const importsAxe = await new AxeBuilder({ page })
			.withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
			.analyze();
		expect(importsAxe.violations).toEqual([]);

		// 9. Audit Notifications
		await navigateSPA("/notifications");
		const notifAxe = await new AxeBuilder({ page })
			.withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
			.analyze();
		expect(notifAxe.violations).toEqual([]);

		// 10. Audit Command Palette
		await page.keyboard.press("Meta+k");
		const palette = page.locator('[data-testid="command-palette-dialog"]');
		if (await palette.isVisible({ timeout: 2000 }).catch(() => false)) {
			const paletteAxe = await new AxeBuilder({ page })
				.withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
				.analyze();
			expect(paletteAxe.violations).toEqual([]);
			await page.keyboard.press("Escape");
		}

		// 11. Audit Quick Entry Sheet
		const quickEntryBtn = page
			.locator(
				'[data-testid="mobile-quick-entry-fab"], [data-testid="desktop-quick-entry-btn"], [data-testid="bottom-nav-quick-entry"]',
			)
			.first();
		await quickEntryBtn.click();
		await expect(
			page.locator('[data-testid="quick-entry-sheet"]'),
		).toBeVisible();

		const quickEntryAxe = await new AxeBuilder({ page })
			.withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
			.analyze();
		expect(quickEntryAxe.violations).toEqual([]);
	});
});

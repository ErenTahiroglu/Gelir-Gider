import { expect, test } from "@playwright/test";
import { authenticateOrUnlock } from "./helpers/auth";
import { attachVirtualAuthenticator } from "./helpers/virtual-webauthn";

test.describe("Critical E2E Smoke & Release Gates (F10)", () => {
	test("executes end-to-end user flow: Bootstrap -> Quick Entry -> Card Payment -> Person Settlement -> Month Close", async ({
		page,
	}) => {
		// 1. Console error and network failure gates
		const consoleErrors: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "error") {
				// Filter out known benign browser/testing messages if any
				const text = msg.text();
				if (!text.includes("favicon.ico")) {
					consoleErrors.push(text);
				}
			}
		});
		page.on("pageerror", (err) => {
			consoleErrors.push(`[PAGE_ERROR] ${err.message}`);
		});
		page.on("response", (res) => {
			if (res.status() >= 500) {
				consoleErrors.push(`[HTTP_5XX] ${res.status()} ${res.url()}`);
			}
		});

		// 2. Attach CDP virtual authenticator
		await attachVirtualAuthenticator(page);

		// 3. Complete Passkey Bootstrap Enrollment & land on Dashboard
		await authenticateOrUnlock(page);

		// 4. Verify Passkey Lock & Unlock cycle with virtual authenticator
		const lockBtn = page.locator('[data-testid="manual-lock-btn"]');
		await lockBtn.click();
		const unlockBtn = page
			.locator(
				'[data-testid="reauth-passkey-button"], [data-testid="unlock-passkey-button"]',
			)
			.first();
		await expect(unlockBtn).toBeVisible({ timeout: 10000 });
		await unlockBtn.click();
		await expect(
			page.locator('[data-testid="dashboard-page"]'),
		).toBeVisible({ timeout: 10000 });

		// 5. Seed prerequisite domain records
		const seedRes = await page.request.post("/__test_seed_prerequisites__", {
			data: {},
		});
		expect(seedRes.status()).toBe(200);
		const seeded = await seedRes.json();
		expect(seeded.cardId).toBeDefined();

		// 6. Quick Entry flow: Create manual expense
		const quickEntryBtn = page
			.locator(
				'[data-testid="desktop-quick-entry-btn"], [data-testid="mobile-quick-entry-fab"]',
			)
			.first();
		await quickEntryBtn.click();

		const quickEntrySheet = page.locator(
			'[data-testid="quick-entry-sheet"]',
		);
		await expect(quickEntrySheet).toBeVisible();

		// Select Nakit / Banka Harcaması
		const cashBtn = page.locator('[data-testid="quick-entry-cash-btn"]');
		await cashBtn.click();

		// Fill expense amount
		const amountInput = page
			.locator('#expense-amount, [data-testid="money-input"]')
			.first();
		await expect(amountInput).toBeVisible();
		await amountInput.fill("125,50");

		// Select payment source account
		const accountSelect = page.locator(
			'#expense-account, [data-testid="expense-account-select"]',
		);
		await accountSelect.selectOption(seeded.assetAccountId);

		// Submit expense
		const submitExpenseBtn = page.locator(
			'[data-testid="expense-submit-btn"]',
		);
		await submitExpenseBtn.click();

		// Assert sheet closed
		await expect(quickEntrySheet).not.toBeVisible({ timeout: 10000 });

		async function navigateSPA(url: string) {
			await page.evaluate((targetUrl: string) => {
				window.history.pushState({}, "", targetUrl);
				window.dispatchEvent(new PopStateEvent("popstate"));
			}, url);
			const unlockBtn = page
				.locator(
					'[data-testid="unlock-passkey-button"], [data-testid="reauth-passkey-button"]',
				)
				.first();
			if (await unlockBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
				await unlockBtn.click();
			}
		}

		// 7. Card Payment flow
		// Navigate to statement detail using seeded card & statement
		await navigateSPA(`/cards/${seeded.cardId}/statements/${seeded.statementId}`);
		await expect(
			page.locator('[data-testid="statement-detail-page"]'),
		).toBeVisible({ timeout: 10000 });

		// Click "Ekstreyi Öde"
		const payBtn = page.locator('[data-testid="detail-pay-btn"]');
		await expect(payBtn).toBeVisible({ timeout: 10000 });
		await payBtn.click();

		// Ensure Vadesiz TL account is selected in the pay modal
		const assetSelect = page.locator('[data-testid="pay-asset-select"]');
		await expect(assetSelect).toBeVisible({ timeout: 10000 });
		await assetSelect.selectOption(seeded.assetAccountId);

		const confirmPayBtn = page.locator(
			'[data-testid="confirm-statement-pay-button"]',
		);
		await expect(confirmPayBtn).toBeVisible({ timeout: 10000 });
		await confirmPayBtn.click();

		// Assert statement status updated to PAID (reopen button appears)
		await expect(
			page.locator('[data-testid="detail-reopen-btn"]'),
		).toBeVisible({ timeout: 10000 });

		// 8. Person Settlement flow
		// Navigate to seeded person detail
		await navigateSPA(`/people/${seeded.personId}`);
		await expect(
			page.locator('[data-testid="person-detail-page"]'),
		).toBeVisible({ timeout: 10000 });

		// Click "Ödeme Al" / Settle receivables
		const settleActionBtn = page.locator(
			'[data-testid="settle-receivables-action-btn"]',
		);
		await expect(settleActionBtn).toBeVisible();
		await settleActionBtn.click();

		// On Settle page
		await expect(page).toHaveURL(new RegExp(`/people/${seeded.personId}/settle`));
		const submitSettleBtn = page.locator(
			'[data-testid="settle-submit-btn"]',
		);
		await expect(submitSettleBtn).toBeVisible({ timeout: 10000 });
		await submitSettleBtn.click();

		// Verify success state
		await expect(
			page.locator('[data-testid="settle-receivables-success-view"]'),
		).toBeVisible({ timeout: 10000 });

		// 9. Month Close Wizard flow
		await navigateSPA(
			`/month-close/wizard?periodMonth=${seeded.previousPeriodMonth}`,
		);
		await expect(
			page.locator('[data-testid="month-close-wizard"]'),
		).toBeVisible({ timeout: 10000 });

		// Advance through wizard steps (1 -> 2 -> 3 -> 4)
		for (let s = 1; s <= 4; s++) {
			const nextBtn = page.locator('[data-testid="btn-wizard-next"]');
			await expect(nextBtn).toBeVisible({ timeout: 10000 });
			await expect(nextBtn).toBeEnabled({ timeout: 10000 });
			await nextBtn.click();
		}

		// Step 5: Commit month close
		const commitBtn = page.locator('[data-testid="btn-commit-month-close"]');
		await expect(commitBtn).toBeVisible({ timeout: 10000 });
		await commitBtn.click();

		// Assert celebration/success screen
		await expect(
			page.locator('.wizard-celebration-container, [data-testid="month-close-wizard"]'),
		).toContainText("Tamamlandı", { timeout: 10000 });

		// 10. Horizontal Overflow check (Must not overflow horizontally)
		const hasHorizontalOverflow = await page.evaluate(() => {
			return (
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth
			);
		});
		expect(hasHorizontalOverflow).toBe(false);

		// 11. Assert Zero unexpected console errors
		expect(consoleErrors).toEqual([]);
	});
});

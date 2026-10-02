import { expect, type Page } from "@playwright/test";
import { TEST_BOOTSTRAP_TOKEN } from "./test-server";

export async function authenticateOrUnlock(page: Page): Promise<void> {
	page.on("pageerror", (err) => {
		console.error("[PAGE_ERROR_IN_AUTH]", err);
	});

	// Reset database to ensure clean, isolated state for this test's virtual authenticator
	await page.request.post("/__test_reset_db__");

	await page.goto("/");

	// Wait until booting spinner goes away
	await page
		.waitForSelector('[data-testid="booting-shell"]', {
			state: "detached",
			timeout: 15000,
		})
		.catch(() => {});

	// Wait for any auth screen: bootstrap, unlock, or already unlocked dashboard
	await page.waitForSelector(
		'[data-testid="bootstrap-token-input"], [data-testid="unlock-passkey-button"], [data-testid="dashboard-page"]',
		{ timeout: 15000 },
	);

	if (await page.locator('[data-testid="bootstrap-token-input"]').isVisible()) {
		await page
			.locator('[data-testid="bootstrap-token-input"]')
			.fill(TEST_BOOTSTRAP_TOKEN);
		await page.locator('[data-testid="display-name-input"]').fill("Eren");
		await page.locator('[data-testid="authorize-bootstrap-button"]').click();

		const registerBtn = page.locator(
			'[data-testid="register-passkey-button"]',
		);
		await expect(registerBtn).toBeVisible({ timeout: 15000 });
		await registerBtn.click();

		const ackCheckbox = page.locator(
			'[data-testid="recovery-ack-checkbox"]',
		);
		try {
			await expect(ackCheckbox).toBeVisible({ timeout: 10000 });
		} catch (e) {
			const showErrorBtn = page.locator('button:has-text("Show Error")');
			if (await showErrorBtn.isVisible()) {
				await showErrorBtn.click();
				const errorPre = await page.locator("pre").allInnerTexts();
				console.error("[REACT_RENDER_ERROR_STACK]", errorPre.join("\n"));
			}
			const bodyText = await page.locator("body").innerText();
			console.error("[BODY_TEXT_ON_FAILURE]", bodyText);
			throw e;
		}
		await ackCheckbox.check();
		await page
			.locator('[data-testid="acknowledge-recovery-button"]')
			.click();
	} else if (
		await page.locator('[data-testid="unlock-passkey-button"]').isVisible()
	) {
		await page.locator('[data-testid="unlock-passkey-button"]').click();
	}

	await expect(
		page.locator('[data-testid="dashboard-page"]'),
	).toBeVisible({ timeout: 15000 });
}

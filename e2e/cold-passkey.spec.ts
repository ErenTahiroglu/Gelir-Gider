import { expect, test } from "@playwright/test";
import { TEST_BOOTSTRAP_TOKEN } from "./helpers/test-server";
import { attachVirtualAuthenticator } from "./helpers/virtual-webauthn";

test.describe("Cold-Launch Passkey Contract (Targeted Blocker F)", () => {
	test("valid server session cookie alone != cold-launch unlock; requires fresh Passkey assertion after reload", async ({
		page,
		context,
	}) => {
		// Attach virtual WebAuthn authenticator to browser context
		await attachVirtualAuthenticator(page);

		// 1. Reset disposable DB
		const resetRes = await page.request.post("/__test_reset_db__");
		expect(resetRes.status()).toBe(200);

		// 2. Legitimate bootstrap
		await page.goto("/");
		await page.waitForSelector('[data-testid="bootstrap-token-input"]', {
			timeout: 15000,
		});

		await page
			.locator('[data-testid="bootstrap-token-input"]')
			.fill(TEST_BOOTSTRAP_TOKEN);
		await page.locator('[data-testid="display-name-input"]').fill("Eren");
		await page.locator('[data-testid="authorize-bootstrap-button"]').click();

		// 3. Legitimate Passkey enrollment
		const registerBtn = page.locator(
			'[data-testid="register-passkey-button"]',
		);
		await expect(registerBtn).toBeVisible({ timeout: 15000 });
		await registerBtn.click();

		// Acknowledge recovery code
		const ackCheckbox = page.locator(
			'[data-testid="recovery-ack-checkbox"]',
		);
		await expect(ackCheckbox).toBeVisible({ timeout: 10000 });
		await ackCheckbox.check();
		await page
			.locator('[data-testid="acknowledge-recovery-button"]')
			.click();

		// 4. Reach authenticated/unlocked application (Dashboard)
		const dashboardLocator = page.locator('[data-testid="dashboard-page"]');
		await expect(dashboardLocator).toBeVisible({ timeout: 15000 });

		// 5. Confirm the server session cookie exists
		const cookies = await context.cookies();
		const sessionCookie = cookies.find((c) =>
			c.name.includes("gg_session"),
		);
		expect(
			sessionCookie,
			"Expected __Host-gg_session cookie to exist after enrollment",
		).toBeDefined();
		expect(sessionCookie?.value.length).toBeGreaterThan(10);

		// 6. Perform a genuine application reload/new initialization while retaining that legitimate cookie
		await page.reload();

		// 7. Assert financial content is NOT immediately visible
		await expect(dashboardLocator).not.toBeVisible();

		// 8. Assert application returns to Passkey-required state (UnlockScreen)
		const unlockButton = page.locator('[data-testid="unlock-passkey-button"]');
		await expect(unlockButton).toBeVisible({ timeout: 15000 });

		// Assert financial dashboard is still locked while on unlock screen
		await expect(dashboardLocator).not.toBeVisible();

		// 9. Perform a fresh Passkey assertion with the virtual authenticator
		await unlockButton.click();

		// 10. Only then assert Dashboard becomes accessible
		await expect(dashboardLocator).toBeVisible({ timeout: 15000 });
	});
});

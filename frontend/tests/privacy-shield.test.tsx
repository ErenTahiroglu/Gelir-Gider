import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/auth-context";
import { AuthGate } from "../src/components/auth/AuthGate";

describe("App Privacy Shield (App Switcher Protection)", () => {
	beforeEach(() => {
		sessionStorage.clear();
		vi.restoreAllMocks();
	});

	it("activates privacy shield immediately on hidden, removes on visible <120s, locks on visible >=120s", async () => {
		const fetchMock = vi.fn().mockImplementation((url: string) => {
			if (url === "/auth/status") {
				return Promise.resolve(
					new Response(JSON.stringify({ state: "INITIALIZED" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			if (url === "/auth/session") {
				// User is authenticated
				return Promise.resolve(
					new Response(
						JSON.stringify({
							authenticated: true,
							user: { displayName: "Eren" },
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}
			return Promise.reject(new Error(`Unhandled route ${url}`));
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<AuthProvider>
				<AuthGate>
					<div data-testid="sensitive-financial-portfolio">
						Gizli Finansal Veriler
					</div>
				</AuthGate>
			</AuthProvider>,
		);

		// Wait for unlocked view
		await screen.findByTestId("sensitive-financial-portfolio");

		// 1. Immediately on hidden: privacy shield MUST activate
		const t0 = 100_000;
		vi.spyOn(Date, "now").mockReturnValue(t0);
		await act(async () => {
			Object.defineProperty(document, "visibilityState", {
				value: "hidden",
				configurable: true,
			});
			document.dispatchEvent(new Event("visibilitychange"));
		});

		// Privacy shield is present and content is hidden from screen readers / app preview
		expect(screen.getByTestId("privacy-shield")).toBeInTheDocument();
		const protectedContainer = screen.getByTestId("protected-container");
		const contentWrapper =
			protectedContainer.querySelector(".protected-content");
		expect(contentWrapper).toHaveAttribute("aria-hidden", "true");

		// 2. Return visible after 30 seconds (< 120s)
		vi.spyOn(Date, "now").mockReturnValue(t0 + 30_000);
		await act(async () => {
			Object.defineProperty(document, "visibilityState", {
				value: "visible",
				configurable: true,
			});
			document.dispatchEvent(new Event("visibilitychange"));
		});

		// Shield is removed and content is restored
		expect(screen.queryByTestId("privacy-shield")).not.toBeInTheDocument();
		expect(screen.queryByTestId("locked-overlay")).not.toBeInTheDocument();
		expect(contentWrapper).toHaveAttribute("aria-hidden", "false");

		// 3. Hide again and return after 130 seconds (>= 120s)
		const t1 = 200_000;
		vi.spyOn(Date, "now").mockReturnValue(t1);
		await act(async () => {
			Object.defineProperty(document, "visibilityState", {
				value: "hidden",
				configurable: true,
			});
			document.dispatchEvent(new Event("visibilitychange"));
		});

		expect(screen.getByTestId("privacy-shield")).toBeInTheDocument();

		vi.spyOn(Date, "now").mockReturnValue(t1 + 130_000);
		await act(async () => {
			Object.defineProperty(document, "visibilityState", {
				value: "visible",
				configurable: true,
			});
			document.dispatchEvent(new Event("visibilitychange"));
		});

		// Now locked overlay must be visible and protected content inert
		expect(screen.queryByTestId("privacy-shield")).not.toBeInTheDocument();
		expect(screen.getByTestId("locked-overlay")).toBeInTheDocument();
		expect(contentWrapper).toHaveAttribute("aria-hidden", "true");
	});
});

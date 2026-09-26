import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "../src/App";

describe("F1 Zero Financial Authority on Cold Launch", () => {
	it("does not call financial endpoints or render financial data before authentication", async () => {
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
				return Promise.resolve(
					new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), {
						status: 401,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			return Promise.reject(new Error(`Unhandled route ${url}`));
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<App />);

		await screen.findByTestId("unlock-screen");

		// Verify no financial domain requests were made
		const financialPrefixes = [
			"/budget-v2",
			"/transactions",
			"/credit-cards",
			"/people",
			"/spending",
			"/income",
			"/month-close",
			"/midas",
			"/long-term",
			"/ledger",
		];

		const calledUrls = fetchMock.mock.calls.map((c) => c[0] as string);
		for (const url of calledUrls) {
			for (const prefix of financialPrefixes) {
				expect(url.startsWith(prefix)).toBe(false);
			}
		}

		// Verify no financial amounts or symbols are rendered in the DOM
		const bodyText = document.body.textContent ?? "";
		expect(bodyText).not.toMatch(/₺|\bTRY\b|\bEUR\b|\bUSD\b/);
		expect(bodyText).not.toMatch(/\bTL\b/);
	});
});

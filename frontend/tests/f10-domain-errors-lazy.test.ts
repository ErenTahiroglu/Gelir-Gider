import { describe, expect, it, vi } from "vitest";
import { apiFetch } from "../src/api/client";
import {
	ApiError,
	ensureDomainErrorsLoaded,
	mapErrorCodeToUserMessage,
} from "../src/api/errors";

describe("Domain Error Mapping Lazy Loading (Targeted Blocker C)", () => {
	it("fresh session entering non-card domains receives Turkish domain mappings without loading card routes", async () => {
		// Ensure domain-errors is loaded dynamically as a non-card domain route would do
		await ensureDomainErrorsLoaded();

		// Family 1: People domain
		const peopleErrorMsg = mapErrorCodeToUserMessage(
			"PEOPLE_NOT_FOUND",
			"Generic person not found",
		);
		expect(peopleErrorMsg).toBe("Kişi kaydı bulunamadı.");

		// Family 2: Goals domain
		const goalErrorMsg = mapErrorCodeToUserMessage(
			"SHORT_TERM_GOAL_NOT_FOUND",
			"Generic goal not found",
		);
		expect(goalErrorMsg).toBe("Kısa vadeli hedef bulunamadı.");

		// Family 3: Midas domain
		const midasErrorMsg = mapErrorCodeToUserMessage(
			"MIDAS_ACCOUNT_NOT_FOUND",
			"Generic midas account not found",
		);
		expect(midasErrorMsg).toBe("Midas likidite hesabı bulunamadı.");

		// Family 4: Income domain
		const incomeErrorMsg = mapErrorCodeToUserMessage(
			"INCOME_SOURCE_NOT_FOUND",
			"Generic income source not found",
		);
		expect(incomeErrorMsg).toBe("Gelir kaynağı bulunamadı.");
	});

	it("apiFetch automatically loads domain-error mappings on error before constructing ApiError", async () => {
		const mockResponse = new Response(
			JSON.stringify({
				error: {
					code: "PEOPLE_OBLIGATION_NOT_FOUND",
					message: "Obligation not found",
				},
			}),
			{
				status: 404,
				statusText: "Not Found",
				headers: { "Content-Type": "application/json" },
			},
		);

		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse);

		try {
			await apiFetch("/people/some-id/obligations/ob-1");
			expect.unreachable("Should have thrown ApiError");
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			const apiErr = err as ApiError;
			expect(apiErr.code).toBe("PEOPLE_OBLIGATION_NOT_FOUND");
			expect(apiErr.userMessage).toBe("Borç/alacak kaydı bulunamadı.");
			expect(apiErr.message).toBe("Borç/alacak kaydı bulunamadı.");
		} finally {
			vi.restoreAllMocks();
		}
	});
});

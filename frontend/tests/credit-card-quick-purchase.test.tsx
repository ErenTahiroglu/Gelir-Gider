import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../src/api/client";
import { ApiError } from "../src/api/errors";
import * as manualExpensesApi from "../src/api/manual-expenses-api";
import * as quickEntryApi from "../src/api/quick-entry-api";
import { CreditCardQuickPurchaseForm } from "../src/components/quick-entry/CreditCardQuickPurchaseForm";

function createTestQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
			mutations: { retry: false },
		},
	});
}

describe("Credit Card Quick Purchase Execution (Section 67-70)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	const mockCards = [
		{
			cardId: "card-xyz",
			userId: "usr-1",
			code: "CARD01",
			status: "ACTIVE" as const,
			revisionNo: 1,
			displayName: "Bonus Platinum",
			issuer: "Garanti",
			statementDay: 15,
			dueDay: 25,
			creditLimit: "50000.00",
			lastFour: "1234",
			note: null,
			createdAt: "2026-01-01T00:00:00Z",
			liveLiabilityBalance: "1200.00",
		},
	];

	const mockCategories = [
		{
			id: "cat-coffee",
			userId: "usr-1",
			name: "Kahve & Kafe",
			defaultBudgetCategory: "DISCRETIONARY_SPEND" as const,
			status: "ACTIVE" as const,
			sortOrder: 1,
			systemDefined: false,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		},
	];

	it("Section 67: template prefills and submits canonical POST without template-only metadata fields", async () => {
		vi.spyOn(quickEntryApi, "fetchAllActiveCreditCards").mockResolvedValue(
			mockCards,
		);
		vi.spyOn(manualExpensesApi, "fetchSpendingCategories").mockResolvedValue({
			categories: mockCategories,
		});

		const apiPostSpy = vi.spyOn(client, "apiPost").mockImplementation((url) => {
			if (url.includes("/purchases")) {
				return Promise.resolve({
					eventId: "purchase-evt-123",
					revisionId: "rev-1",
					revisionNo: 1,
					operation: "RECORD_PURCHASE",
					status: "POSTED",
					idempotentReplay: false,
					snapshot: {},
				});
			}
			if (url.includes("/category-assignments")) {
				return Promise.resolve({
					assignment: {
						userId: "usr-1",
						subjectType: "CREDIT_CARD_PURCHASE",
						subjectId: "purchase-evt-123",
						categoryId: "cat-coffee",
						createdAt: "2026-09-28T00:00:00Z",
					},
				});
			}
			return Promise.reject(new Error("Unexpected url: " + url));
		});

		const queryClient = createTestQueryClient();
		render(
			<QueryClientProvider client={queryClient}>
				<CreditCardQuickPurchaseForm
					config={{
						cardId: "card-xyz",
						spendingCategoryId: "cat-coffee",
						budgetCategoryOverride: "DISCRETIONARY_SPEND",
						merchant: "Coffee",
						description: "Sabah kahvesi",
						defaultAmount: "120.00",
					}}
				/>
			</QueryClientProvider>,
		);

		await screen.findByDisplayValue("120,00");
		await screen.findByText(/Bonus Platinum/i);
		expect(screen.getByDisplayValue("Coffee")).toBeInTheDocument();
		expect(screen.getByDisplayValue("Sabah kahvesi")).toBeInTheDocument();
		expect(screen.getByTestId("cc-class-discretionary")).toBeChecked();

		// Submit form
		const submitBtn = screen.getByTestId("cc-submit-btn");
		fireEvent.click(submitBtn);

		await waitFor(() => {
			// Canonical purchase endpoint called with clean payload
			expect(apiPostSpy).toHaveBeenCalledWith(
				"/credit-cards/card-xyz/purchases",
				expect.objectContaining({
					amount: "120.00",
					purchaseCategory: "DISCRETIONARY_SPEND",
					merchant: "Coffee",
					description: "Sabah kahvesi",
					occurredAt: expect.any(String),
				}),
				expect.objectContaining({
					headers: expect.objectContaining({
						"Idempotency-Key": expect.any(String),
					}),
				}),
			);
		});

		// Verify body does NOT contain template-only fields
		const purchaseCall = apiPostSpy.mock.calls.find((call) =>
			(call[0] as string).includes("/purchases"),
		);
		expect(purchaseCall).toBeDefined();
		const purchaseBody = purchaseCall![1] as Record<string, unknown>;
		expect(purchaseBody.defaultAmount).toBeUndefined();
		expect(purchaseBody.spendingCategoryId).toBeUndefined();
		expect(purchaseBody.budgetCategoryOverride).toBeUndefined();
	});

	it("Section 68: category assignment called with purchase eventId after financial commit", async () => {
		vi.spyOn(quickEntryApi, "fetchAllActiveCreditCards").mockResolvedValue(
			mockCards,
		);
		vi.spyOn(manualExpensesApi, "fetchSpendingCategories").mockResolvedValue({
			categories: mockCategories,
		});

		const apiPostSpy = vi.spyOn(client, "apiPost").mockImplementation((url) => {
			if (url.includes("/purchases")) {
				return Promise.resolve({
					eventId: "purchase-123",
					revisionId: "rev-1",
					revisionNo: 1,
					operation: "RECORD_PURCHASE",
					status: "POSTED",
					idempotentReplay: false,
					snapshot: {},
				});
			}
			if (url.includes("/category-assignments")) {
				return Promise.resolve({
					assignment: {
						userId: "usr-1",
						subjectType: "CREDIT_CARD_PURCHASE",
						subjectId: "purchase-123",
						categoryId: "cat-coffee",
						createdAt: "2026-09-28T00:00:00Z",
					},
				});
			}
			return Promise.reject(new Error("Unexpected url: " + url));
		});

		const queryClient = createTestQueryClient();
		render(
			<QueryClientProvider client={queryClient}>
				<CreditCardQuickPurchaseForm
					config={{
						cardId: "card-xyz",
						spendingCategoryId: "cat-coffee",
						defaultAmount: "75.00",
					}}
				/>
			</QueryClientProvider>,
		);

		await screen.findByDisplayValue("75,00");
		await screen.findByText(/Bonus Platinum/i);
		const submitBtn = screen.getByTestId("cc-submit-btn");
		fireEvent.click(submitBtn);

		await waitFor(() => {
			// POST /spending/category-assignments called with subjectId = eventId
			expect(apiPostSpy).toHaveBeenCalledWith(
				"/spending/category-assignments",
				{
					subjectType: "CREDIT_CARD_PURCHASE",
					subjectId: "purchase-123",
					categoryId: "cat-coffee",
				},
			);
		});

		// Financial purchase POST called exactly once
		const purchaseCalls = apiPostSpy.mock.calls.filter((c) =>
			(c[0] as string).includes("/purchases"),
		);
		expect(purchaseCalls).toHaveLength(1);
	});

	it("Section 69: secondary category assignment failure does NOT retry purchase and displays warning", async () => {
		vi.spyOn(quickEntryApi, "fetchAllActiveCreditCards").mockResolvedValue(
			mockCards,
		);
		vi.spyOn(manualExpensesApi, "fetchSpendingCategories").mockResolvedValue({
			categories: mockCategories,
		});

		const apiPostSpy = vi.spyOn(client, "apiPost").mockImplementation((url) => {
			if (url.includes("/purchases")) {
				return Promise.resolve({
					eventId: "purchase-999",
					revisionId: "rev-1",
					revisionNo: 1,
					operation: "RECORD_PURCHASE",
					status: "POSTED",
					idempotentReplay: false,
					snapshot: {},
				});
			}
			if (url.includes("/category-assignments")) {
				return Promise.reject(new Error("Category service down"));
			}
			return Promise.reject(new Error("Unexpected url: " + url));
		});

		const queryClient = createTestQueryClient();
		render(
			<QueryClientProvider client={queryClient}>
				<CreditCardQuickPurchaseForm
					config={{
						cardId: "card-xyz",
						spendingCategoryId: "cat-coffee",
						defaultAmount: "50.00",
					}}
				/>
			</QueryClientProvider>,
		);

		await screen.findByDisplayValue("50,00");
		await screen.findByText(/Bonus Platinum/i);
		fireEvent.click(screen.getByTestId("cc-submit-btn"));

		// Persistent category warning card is displayed
		expect(
			await screen.findByTestId("success-cc-category-warning-card"),
		).toBeInTheDocument();
		expect(
			screen.getByText("Kategori eşlemesi tamamlanamadı."),
		).toBeInTheDocument();
		expect(
			screen.getByText("Finansal işlem tekrar gönderilmeyecek."),
		).toBeInTheDocument();

		// Financial purchase was POSTed exactly once!
		const purchaseCalls = apiPostSpy.mock.calls.filter((c) =>
			(c[0] as string).includes("/purchases"),
		);
		expect(purchaseCalls).toHaveLength(1);

		// No retry button offered for financial purchase
		expect(screen.queryByTestId("cc-form-retry-btn")).not.toBeInTheDocument();

		// User acknowledges manually via Tamam
		const ackBtn = screen.getByTestId("ack-category-warning-btn");
		expect(ackBtn).toBeInTheDocument();
	});

	it("Section 70: uncertain network failure offers retry with same exact key, cardId, and payload", async () => {
		vi.spyOn(quickEntryApi, "fetchAllActiveCreditCards").mockResolvedValue(
			mockCards,
		);
		vi.spyOn(manualExpensesApi, "fetchSpendingCategories").mockResolvedValue({
			categories: mockCategories,
		});

		let attempt = 0;
		const capturedKeys: string[] = [];

		const apiPostSpy = vi
			.spyOn(client, "apiPost")
			.mockImplementation((url, payload, options) => {
				if (url.includes("/purchases")) {
					attempt++;
					const headers = options?.headers as
						| Record<string, string>
						| undefined;
					const key = headers?.["Idempotency-Key"] ?? "";
					capturedKeys.push(key);

					if (attempt === 1) {
						return Promise.reject(
							new ApiError({
								status: 0,
								code: "NETWORK_ERROR",
								message: "Network failure",
							}),
						);
					}

					return Promise.resolve({
						eventId: "purchase-retry-123",
						revisionId: "rev-1",
						revisionNo: 1,
						operation: "RECORD_PURCHASE",
						status: "POSTED",
						idempotentReplay: false,
						snapshot: {},
					});
				}
				return Promise.resolve({});
			});

		const queryClient = createTestQueryClient();
		render(
			<QueryClientProvider client={queryClient}>
				<CreditCardQuickPurchaseForm
					config={{
						cardId: "card-xyz",
						defaultAmount: "250.00",
					}}
				/>
			</QueryClientProvider>,
		);

		await screen.findByDisplayValue("250,00");
		await screen.findByText(/Bonus Platinum/i);
		fireEvent.click(screen.getByTestId("cc-submit-btn"));

		// Network failure message & retry button appears
		expect(await screen.findByTestId("cc-form-error-banner")).toHaveTextContent(
			"Kart harcamasının kaydedilip kaydedilmediği doğrulanamadı.",
		);
		const retryBtn = screen.getByTestId("cc-form-retry-btn");
		expect(retryBtn).toBeInTheDocument();

		// Click Tekrar Dene
		fireEvent.click(retryBtn);

		await waitFor(() => {
			expect(attempt).toBe(2);
		});

		// Both attempts must use the EXACT same Idempotency-Key!
		expect(capturedKeys).toHaveLength(2);
		expect(capturedKeys[0]).toBeDefined();
		expect(capturedKeys[0]).toBe(capturedKeys[1]);
	});
});

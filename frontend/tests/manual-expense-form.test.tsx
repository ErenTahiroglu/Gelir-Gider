import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManualExpenseForm } from "../src/components/manual-expenses/ManualExpenseForm";

function createTestQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
}

describe("Manual Expense Form Component — Create, Edit & OCC", () => {
	let queryClient: QueryClient;

	beforeEach(() => {
		queryClient = createTestQueryClient();
		vi.restoreAllMocks();
	});

	afterEach(() => {
		queryClient.clear();
	});

	const mockAccounts = [
		{
			accountId: "acc-111",
			code: "100.01",
			name: "Nakit Kasa",
			accountType: "ASSET",
			normalBalance: "DEBIT" as const,
			currency: "TRY",
			archived: false,
			balance: "5000.00",
		},
		{
			accountId: "acc-archived",
			code: "100.02",
			name: "Eski Kasa",
			accountType: "ASSET",
			normalBalance: "DEBIT" as const,
			currency: "TRY",
			archived: true,
			balance: "0.00",
		},
	];

	const mockCategories = [
		{
			id: "cat-market",
			name: "Market",
			defaultBudgetCategory: "MANDATORY_EXPENSE",
			status: "ACTIVE",
			sortOrder: 1,
			systemDefined: true,
		},
		{
			id: "cat-dining",
			name: "Dışarıda Yemek",
			defaultBudgetCategory: "ASK",
			status: "ACTIVE",
			sortOrder: 2,
			systemDefined: true,
		},
		{
			id: "cat-archived",
			name: "Eski Kategori",
			defaultBudgetCategory: "MANDATORY_EXPENSE",
			status: "ARCHIVED",
			sortOrder: 3,
			systemDefined: false,
		},
	];

	it("shows only active TRY asset accounts and active categories", async () => {
		global.fetch = vi.fn().mockImplementation((url: string) => {
			if (url.includes("/ledger/accounts")) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({ accounts: mockAccounts, nextCursor: null }),
					headers: new Headers({ "content-type": "application/json" }),
				});
			}
			if (url.includes("/spending/categories")) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ categories: mockCategories }),
					headers: new Headers({ "content-type": "application/json" }),
				});
			}
			return Promise.reject(new Error(`Unhandled URL: ${url}`));
		});

		render(
			<QueryClientProvider client={queryClient}>
				<ManualExpenseForm mode="create" />
			</QueryClientProvider>,
		);

		await waitFor(() => {
			expect(
				screen.getByRole("option", { name: /Nakit Kasa \(₺5\.000,00\)/i }),
			).toBeInTheDocument();
		});

		// Archived account should NOT be in selectable options
		expect(screen.queryByText(/Eski Kasa/i)).not.toBeInTheDocument();

		// Active categories should be present, archived category excluded
		expect(screen.getByText("Market")).toBeInTheDocument();
		expect(screen.getByText("Dışarıda Yemek")).toBeInTheDocument();
		expect(screen.queryByText("Eski Kategori")).not.toBeInTheDocument();
	});

	it("resolves ASK default budgetCategory to MANDATORY_EXPENSE default and never sends ASK", async () => {
		const captured: {
			postPayload: Record<string, any> | null;
			headers: Headers | null;
		} = {
			postPayload: null,
			headers: null,
		};

		global.fetch = vi
			.fn()
			.mockImplementation((url: string, init?: RequestInit) => {
				if (url.includes("/ledger/accounts")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: () =>
							Promise.resolve({ accounts: mockAccounts, nextCursor: null }),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				if (url.includes("/spending/categories")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: () => Promise.resolve({ categories: mockCategories }),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				if (url.includes("/manual-expenses") && init?.method === "POST") {
					captured.postPayload = JSON.parse(init.body as string);
					captured.headers = new Headers(init.headers);
					return Promise.resolve({
						ok: true,
						status: 201,
						json: () =>
							Promise.resolve({
								transactionId: "tx-new-123",
								revisionId: "rev-1",
								revisionNo: 1,
								operation: "CREATE",
							}),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				if (url.includes("/spending/category-assignments")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: () =>
							Promise.resolve({
								assignments: { "tx-new-123": "cat-dining" },
							}),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				return Promise.reject(new Error(`Unhandled URL: ${url}`));
			});

		render(
			<QueryClientProvider client={queryClient}>
				<ManualExpenseForm mode="create" />
			</QueryClientProvider>,
		);

		await waitFor(() => {
			expect(screen.getByText("Dışarıda Yemek")).toBeInTheDocument();
		});

		// Select "Dışarıda Yemek" (which has defaultBudgetCategory = ASK)
		const categorySelect = screen.getByTestId("expense-category-select");
		fireEvent.change(categorySelect, { target: { value: "cat-dining" } });

		expect(screen.getByTestId("ask-category-hint")).toBeInTheDocument();

		// Default should be MANDATORY_EXPENSE
		const mandatoryRadio = screen.getByTestId("class-mandatory");
		expect(mandatoryRadio).toBeChecked();

		// Switch to DISCRETIONARY_SPEND
		const discretionaryRadio = screen.getByTestId("class-discretionary");
		fireEvent.click(discretionaryRadio);
		expect(discretionaryRadio).toBeChecked();

		// Enter valid amount
		const moneyInput = screen.getByTestId("money-input");
		fireEvent.change(moneyInput, { target: { value: "150,50" } });
		fireEvent.blur(moneyInput);

		// Submit form
		const submitBtn = screen.getByTestId("expense-submit-btn");
		fireEvent.click(submitBtn);

		await waitFor(() => {
			expect(captured.postPayload).not.toBeNull();
		});

		expect(captured.postPayload?.amount).toBe("150.50");
		expect(captured.postPayload?.sourceAssetAccountId).toBe("acc-111");
		expect(captured.postPayload?.budgetCategory).toBe("DISCRETIONARY_SPEND");
		expect(captured.postPayload?.budgetCategory).not.toBe("ASK");

		// Header Idempotency-Key
		expect(captured.headers?.get("Idempotency-Key")).toBeTruthy();
	});

	it("uses fresh revisionNo as expectedRevisionNo on edit and refetches on 409 conflict", async () => {
		const capturedUpdate: { payload: Record<string, any> | null } = {
			payload: null,
		};
		let fetchExpenseCount = 0;

		const mockExistingExpense = {
			id: "tx-existing-123",
			userId: "user-1",
			kind: "MANUAL_EXPENSE",
			status: "ACTIVE",
			revisionNo: 3,
			amount: "200.00",
			occurredAt: "2026-09-28T12:00:00Z",
			payload: {
				amount: "200.00",
				sourceAssetAccountId: "acc-111",
				budgetCategory: "MANDATORY_EXPENSE",
				merchant: "Old Merchant",
			},
			createdAt: "2026-09-28T12:00:00Z",
			updatedAt: "2026-09-28T12:00:00Z",
		};

		global.fetch = vi
			.fn()
			.mockImplementation((url: string, init?: RequestInit) => {
				if (url.includes("/ledger/accounts")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: () =>
							Promise.resolve({ accounts: mockAccounts, nextCursor: null }),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				if (url.includes("/spending/categories")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: () => Promise.resolve({ categories: mockCategories }),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				if (url.includes("/manual-expenses/tx-existing-123")) {
					if (init?.method === "POST") {
						capturedUpdate.payload = JSON.parse(init.body as string);
						// Simulate revision conflict 409
						return Promise.resolve({
							ok: false,
							status: 409,
							json: () =>
								Promise.resolve({
									error: {
										code: "MANUAL_EXPENSE_REVISION_CONFLICT",
										message: "Revision conflict",
									},
								}),
							headers: new Headers({ "content-type": "application/json" }),
						});
					}

					fetchExpenseCount++;
					return Promise.resolve({
						ok: true,
						status: 200,
						json: () => Promise.resolve({ expense: mockExistingExpense }),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				return Promise.reject(new Error(`Unhandled URL: ${url}`));
			});

		render(
			<QueryClientProvider client={queryClient}>
				<ManualExpenseForm mode="edit" expenseId="tx-existing-123" />
			</QueryClientProvider>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("expense-merchant-input")).toHaveValue(
				"Old Merchant",
			);
		});

		// Submit edit
		const submitBtn = screen.getByTestId("expense-submit-btn");
		fireEvent.click(submitBtn);

		await waitFor(() => {
			expect(capturedUpdate.payload).not.toBeNull();
		});

		expect(capturedUpdate.payload?.expectedRevisionNo).toBe(3);

		// Assert conflict notice and refetch trigger
		await waitFor(() => {
			expect(screen.getByTestId("form-error-banner")).toHaveTextContent(
				"Bu harcama başka bir işlemle güncellendi. Son hali yüklendi.",
			);
		});

		expect(fetchExpenseCount).toBeGreaterThan(1);
	});

	it("handles category verification mismatch by showing persistent warning without duplicating financial mutation", async () => {
		let postCount = 0;
		const mockOnSuccess = vi.fn();

		global.fetch = vi
			.fn()
			.mockImplementation((url: string, init?: RequestInit) => {
				if (url.includes("/ledger/accounts")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: () =>
							Promise.resolve({ accounts: mockAccounts, nextCursor: null }),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				if (url.includes("/spending/categories")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: () => Promise.resolve({ categories: mockCategories }),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				if (url.includes("/manual-expenses") && init?.method === "POST") {
					postCount++;
					return Promise.resolve({
						ok: true,
						status: 201,
						json: () =>
							Promise.resolve({
								transactionId: "tx-mismatch-1",
								revisionId: "rev-1",
								revisionNo: 1,
								operation: "CREATE",
							}),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				if (url.includes("/spending/category-assignments")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: () =>
							Promise.resolve({
								assignments: { "tx-mismatch-1": "different-category" },
							}),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				return Promise.reject(new Error(`Unhandled URL: ${url}`));
			});

		render(
			<QueryClientProvider client={queryClient}>
				<ManualExpenseForm mode="create" onSuccess={mockOnSuccess} />
			</QueryClientProvider>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("expense-category-select")).toBeInTheDocument();
			expect(screen.getByTestId("expense-account-select")).toHaveValue(
				"acc-111",
			);
		});

		// Select category "cat-market"
		fireEvent.change(screen.getByTestId("expense-category-select"), {
			target: { value: "cat-market" },
		});

		// Enter amount
		const moneyInput = screen.getByTestId("money-input");
		fireEvent.change(moneyInput, { target: { value: "100" } });
		fireEvent.blur(moneyInput);

		// Submit form
		const submitBtn = screen.getByTestId("expense-submit-btn");
		fireEvent.click(submitBtn);

		// Wait for category warning card to appear
		await waitFor(() => {
			expect(
				screen.getByTestId("success-category-warning-card"),
			).toBeInTheDocument();
		});

		// Verify warning messages per Section 13-14
		expect(screen.getByText("Harcama kaydedildi")).toBeInTheDocument();
		expect(
			screen.getByText("Kategori eşlemesi doğrulanamadı."),
		).toBeInTheDocument();
		expect(
			screen.getByText("İşlem finansal olarak kaydedildi; tekrar göndermeyin."),
		).toBeInTheDocument();

		// POST called exactly once
		expect(postCount).toBe(1);

		// onSuccess was not called yet (user must review warning)
		expect(mockOnSuccess).not.toHaveBeenCalled();

		// Submit button should NOT be rendered in this post-success state (prevents duplicate submissions)
		expect(screen.queryByTestId("expense-submit-btn")).not.toBeInTheDocument();

		// User clicks return to transactions
		const returnBtn = screen.getByTestId("return-to-transactions-btn");
		fireEvent.click(returnBtn);

		expect(mockOnSuccess).toHaveBeenCalledWith("tx-mismatch-1");
		expect(postCount).toBe(1);
	});

	it("handles category verification network failure by preserving financial success and showing warning", async () => {
		let postCount = 0;
		const mockOnSuccess = vi.fn();

		global.fetch = vi
			.fn()
			.mockImplementation((url: string, init?: RequestInit) => {
				if (url.includes("/ledger/accounts")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: () =>
							Promise.resolve({ accounts: mockAccounts, nextCursor: null }),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				if (url.includes("/spending/categories")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: () => Promise.resolve({ categories: mockCategories }),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				if (url.includes("/manual-expenses") && init?.method === "POST") {
					postCount++;
					return Promise.resolve({
						ok: true,
						status: 201,
						json: () =>
							Promise.resolve({
								transactionId: "tx-netfail-1",
								revisionId: "rev-1",
								revisionNo: 1,
								operation: "CREATE",
							}),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				if (url.includes("/spending/category-assignments")) {
					// Simulate network failure
					return Promise.reject(new TypeError("Failed to fetch"));
				}
				return Promise.reject(new Error(`Unhandled URL: ${url}`));
			});

		render(
			<QueryClientProvider client={queryClient}>
				<ManualExpenseForm mode="create" onSuccess={mockOnSuccess} />
			</QueryClientProvider>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("expense-category-select")).toBeInTheDocument();
			expect(screen.getByTestId("expense-account-select")).toHaveValue(
				"acc-111",
			);
		});

		// Select category
		fireEvent.change(screen.getByTestId("expense-category-select"), {
			target: { value: "cat-market" },
		});

		// Enter amount
		const moneyInput = screen.getByTestId("money-input");
		fireEvent.change(moneyInput, { target: { value: "250" } });
		fireEvent.blur(moneyInput);

		// Submit form
		const submitBtn = screen.getByTestId("expense-submit-btn");
		fireEvent.click(submitBtn);

		await waitFor(() => {
			expect(
				screen.getByTestId("success-category-warning-card"),
			).toBeInTheDocument();
		});

		expect(postCount).toBe(1);
		expect(
			screen.getByText("Kategori eşlemesi doğrulanamadı."),
		).toBeInTheDocument();
		// Retry financial mutation button must NOT be offered
		expect(screen.queryByTestId("expense-retry-btn")).not.toBeInTheDocument();
		expect(screen.queryByTestId("expense-submit-btn")).not.toBeInTheDocument();

		// User clicks return to transactions
		fireEvent.click(screen.getByTestId("return-to-transactions-btn"));
		expect(mockOnSuccess).toHaveBeenCalledWith("tx-netfail-1");
		expect(postCount).toBe(1);
	});

	it("navigates immediately on full success when category assignment is confirmed", async () => {
		let postCount = 0;
		const mockOnSuccess = vi.fn();

		global.fetch = vi
			.fn()
			.mockImplementation((url: string, init?: RequestInit) => {
				if (url.includes("/ledger/accounts")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: () =>
							Promise.resolve({ accounts: mockAccounts, nextCursor: null }),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				if (url.includes("/spending/categories")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: () => Promise.resolve({ categories: mockCategories }),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				if (url.includes("/manual-expenses") && init?.method === "POST") {
					postCount++;
					return Promise.resolve({
						ok: true,
						status: 201,
						json: () =>
							Promise.resolve({
								transactionId: "tx-full-success-1",
								revisionId: "rev-1",
								revisionNo: 1,
								operation: "CREATE",
							}),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				if (url.includes("/spending/category-assignments")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: () =>
							Promise.resolve({
								assignments: { "tx-full-success-1": "cat-market" },
							}),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				return Promise.reject(new Error(`Unhandled URL: ${url}`));
			});

		render(
			<QueryClientProvider client={queryClient}>
				<ManualExpenseForm mode="create" onSuccess={mockOnSuccess} />
			</QueryClientProvider>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("expense-category-select")).toBeInTheDocument();
			expect(screen.getByTestId("expense-account-select")).toHaveValue(
				"acc-111",
			);
		});

		// Select category
		fireEvent.change(screen.getByTestId("expense-category-select"), {
			target: { value: "cat-market" },
		});

		// Enter amount
		const moneyInput = screen.getByTestId("money-input");
		fireEvent.change(moneyInput, { target: { value: "300" } });
		fireEvent.blur(moneyInput);

		// Submit form
		const submitBtn = screen.getByTestId("expense-submit-btn");
		fireEvent.click(submitBtn);

		await waitFor(() => {
			expect(mockOnSuccess).toHaveBeenCalledWith("tx-full-success-1");
		});

		expect(postCount).toBe(1);
		expect(
			screen.queryByTestId("success-category-warning-card"),
		).not.toBeInTheDocument();
	});
});

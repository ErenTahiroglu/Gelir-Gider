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
			normalBalance: "DEBIT",
			currency: "TRY",
			archived: false,
			balance: { balance: "5000.00", normalBalanceSide: "DEBIT" },
		},
		{
			accountId: "acc-archived",
			code: "100.02",
			name: "Eski Kasa",
			accountType: "ASSET",
			normalBalance: "DEBIT",
			currency: "TRY",
			archived: true,
			balance: { balance: "0.00", normalBalanceSide: "DEBIT" },
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
				screen.getByRole("option", { name: /Nakit Kasa/i }),
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
});

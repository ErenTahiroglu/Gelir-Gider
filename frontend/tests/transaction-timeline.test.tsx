import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionTimeline } from "../src/components/transactions/TransactionTimeline";

function createTestQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
			},
		},
	});
}

describe("Transaction Timeline Component — Keyset Pagination & Filtering", () => {
	let queryClient: QueryClient;

	beforeEach(() => {
		queryClient = createTestQueryClient();
		vi.restoreAllMocks();
	});

	afterEach(() => {
		queryClient.clear();
	});

	it("renders empty state when no transactions exist and offers scoped add button", async () => {
		global.fetch = vi.fn().mockImplementation((url: string) => {
			if (url.includes("/transactions")) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ transactions: [], nextCursor: null }),
					headers: new Headers({ "content-type": "application/json" }),
				});
			}
			if (url.includes("/ledger/accounts")) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ accounts: [], nextCursor: null }),
					headers: new Headers({ "content-type": "application/json" }),
				});
			}
			if (url.includes("/spending/categories")) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ categories: [] }),
					headers: new Headers({ "content-type": "application/json" }),
				});
			}
			return Promise.reject(new Error(`Unhandled URL: ${url}`));
		});

		render(
			<QueryClientProvider client={queryClient}>
				<TransactionTimeline />
			</QueryClientProvider>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("timeline-empty")).toBeInTheDocument();
		});

		expect(screen.getByText("Henüz hareket yok.")).toBeInTheDocument();
		expect(screen.getByTestId("empty-add-expense-btn")).toBeInTheDocument();
	});

	it("renders transaction rows and keyset pagination fetches next page using both cursor fields", async () => {
		const page1Tx = [
			{
				transactionId: "11111111-1111-1111-1111-111111111111",
				kind: "MANUAL_EXPENSE",
				status: "ACTIVE",
				revisionNo: 1,
				occurredAt: "2026-09-28T12:00:00Z",
				payload: {
					amount: "150.00",
					merchant: "Test Cafe",
				},
				createdAt: "2026-09-28T12:00:00Z",
				latestRevisionCreatedAt: "2026-09-28T12:00:00Z",
			},
		];

		const page2Tx = [
			{
				transactionId: "22222222-2222-2222-2222-222222222222",
				kind: "MANUAL_EXPENSE",
				status: "ACTIVE",
				revisionNo: 1,
				occurredAt: "2026-09-27T12:00:00Z",
				payload: {
					amount: "250.00",
					merchant: "Test Market",
				},
				createdAt: "2026-09-27T12:00:00Z",
				latestRevisionCreatedAt: "2026-09-27T12:00:00Z",
			},
		];

		const fetchMock = vi.fn().mockImplementation((url: string) => {
			if (url.includes("/transactions")) {
				if (url.includes("beforeOccurredAt=")) {
					expect(url).toContain("beforeOccurredAt=2026-09-28T12%3A00%3A00Z");
					expect(url).toContain(
						"beforeTransactionId=11111111-1111-1111-1111-111111111111",
					);
					return Promise.resolve({
						ok: true,
						status: 200,
						json: () =>
							Promise.resolve({
								transactions: page2Tx,
								nextCursor: null,
							}),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}

				return Promise.resolve({
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							transactions: page1Tx,
							nextCursor: {
								beforeOccurredAt: "2026-09-28T12:00:00Z",
								beforeTransactionId: "11111111-1111-1111-1111-111111111111",
							},
						}),
					headers: new Headers({ "content-type": "application/json" }),
				});
			}
			if (url.includes("/ledger/accounts")) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ accounts: [], nextCursor: null }),
					headers: new Headers({ "content-type": "application/json" }),
				});
			}
			if (url.includes("/spending/categories")) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ categories: [] }),
					headers: new Headers({ "content-type": "application/json" }),
				});
			}
			return Promise.reject(new Error(`Unhandled URL: ${url}`));
		});

		global.fetch = fetchMock;

		render(
			<QueryClientProvider client={queryClient}>
				<TransactionTimeline />
			</QueryClientProvider>,
		);

		await waitFor(() => {
			expect(screen.getAllByText("Test Cafe")[0]).toBeInTheDocument();
		});

		const loadMoreBtn = screen.getByTestId("load-more-btn");
		expect(loadMoreBtn).toBeInTheDocument();
		fireEvent.click(loadMoreBtn);

		await waitFor(() => {
			expect(screen.getAllByText("Test Market")[0]).toBeInTheDocument();
		});
	});

	it("switches status filter and passes status parameter to /transactions", async () => {
		const fetchMock = vi.fn().mockImplementation((url: string) => {
			if (url.includes("/transactions")) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ transactions: [], nextCursor: null }),
					headers: new Headers({ "content-type": "application/json" }),
				});
			}
			if (url.includes("/ledger/accounts")) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ accounts: [], nextCursor: null }),
					headers: new Headers({ "content-type": "application/json" }),
				});
			}
			if (url.includes("/spending/categories")) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ categories: [] }),
					headers: new Headers({ "content-type": "application/json" }),
				});
			}
			return Promise.reject(new Error(`Unhandled URL: ${url}`));
		});

		global.fetch = fetchMock;

		render(
			<QueryClientProvider client={queryClient}>
				<TransactionTimeline />
			</QueryClientProvider>,
		);

		const filterActive = screen.getByTestId("filter-active");
		fireEvent.click(filterActive);

		await waitFor(() => {
			const calledUrls = fetchMock.mock.calls.map((c) => c[0]);
			const hasStatusActive = calledUrls.some((u) =>
				u.includes("status=ACTIVE"),
			);
			expect(hasStatusActive).toBe(true);
		});
	});
});

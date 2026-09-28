import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionDetailDrawer } from "../src/components/transactions/TransactionDetailDrawer";

function createTestQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
}

describe("Transaction Detail Drawer & Void Flow — F3", () => {
	let queryClient: QueryClient;

	beforeEach(() => {
		queryClient = createTestQueryClient();
		vi.restoreAllMocks();
	});

	afterEach(() => {
		queryClient.clear();
	});

	const mockTx = {
		transactionId: "tx-void-test-1",
		kind: "MANUAL_EXPENSE",
		status: "ACTIVE",
		revisionNo: 2,
		occurredAt: "2026-09-28T14:00:00Z",
		payload: {
			amount: "175.00",
			merchant: "Kitapçı",
			description: "Roman",
		},
		createdAt: "2026-09-28T14:00:00Z",
		latestRevisionCreatedAt: "2026-09-28T14:00:00Z",
	};

	const mockRevisions = [
		{
			revisionNo: 2,
			operation: "UPDATE",
			occurredAt: "2026-09-28T14:30:00Z",
			payload: { amount: "175.00" },
			reasonCode: "USER_EDIT",
			reasonNote: "Tutar güncellendi",
			createdAt: "2026-09-28T14:30:00Z",
		},
		{
			revisionNo: 1,
			operation: "CREATE",
			occurredAt: "2026-09-28T14:00:00Z",
			payload: { amount: "150.00" },
			reasonCode: null,
			reasonNote: null,
			createdAt: "2026-09-28T14:00:00Z",
		},
	];

	it("renders transaction detail, revision timeline and executes void with fresh expectedRevisionNo", async () => {
		const capturedVoid: {
			payload: Record<string, any> | null;
			headers: Headers | null;
		} = {
			payload: null,
			headers: null,
		};

		global.fetch = vi
			.fn()
			.mockImplementation((url: string, init?: RequestInit) => {
				if (url.includes("/transactions/tx-void-test-1/revisions")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: () =>
							Promise.resolve({
								transactionId: "tx-void-test-1",
								revisions: mockRevisions,
								nextCursor: null,
							}),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				if (url.includes("/transactions/tx-void-test-1")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: () => Promise.resolve(mockTx),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				if (
					url.includes("/manual-expenses/tx-void-test-1/void") &&
					init?.method === "POST"
				) {
					capturedVoid.payload = JSON.parse(init.body as string);
					capturedVoid.headers = new Headers(init.headers);
					return Promise.resolve({
						ok: true,
						status: 200,
						json: () =>
							Promise.resolve({
								transactionId: "tx-void-test-1",
								revisionId: "rev-3",
								revisionNo: 3,
								operation: "VOID",
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
				if (url.includes("/spending/category-assignments")) {
					return Promise.resolve({
						ok: true,
						status: 200,
						json: () => Promise.resolve({ assignments: {} }),
						headers: new Headers({ "content-type": "application/json" }),
					});
				}
				return Promise.reject(new Error(`Unhandled URL: ${url}`));
			});

		render(
			<QueryClientProvider client={queryClient}>
				<TransactionDetailDrawer
					transactionId="tx-void-test-1"
					isOpen={true}
					onClose={vi.fn()}
				/>
			</QueryClientProvider>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("detail-content")).toBeInTheDocument();
		});

		expect(screen.getByText("Kitapçı")).toBeInTheDocument();
		expect(screen.getByText("-₺175,00")).toBeInTheDocument();

		// Action buttons visible for active MANUAL_EXPENSE
		const voidTriggerBtn = screen.getByTestId("detail-void-btn");
		expect(voidTriggerBtn).toBeInTheDocument();
		expect(screen.getByTestId("detail-edit-btn")).toBeInTheDocument();

		// Open void confirmation dialog
		fireEvent.click(voidTriggerBtn);

		await waitFor(() => {
			expect(screen.getByTestId("void-confirm-btn")).toBeInTheDocument();
		});

		// Enter optional reason
		const reasonInput = screen.getByTestId("void-reason-input");
		fireEvent.change(reasonInput, { target: { value: "İptal denemesi" } });

		// Confirm void
		const confirmBtn = screen.getByTestId("void-confirm-btn");
		fireEvent.click(confirmBtn);

		await waitFor(() => {
			expect(capturedVoid.payload).not.toBeNull();
		});

		expect(capturedVoid.payload?.expectedRevisionNo).toBe(2);
		expect(capturedVoid.payload?.reason).toBe("İptal denemesi");
		expect(capturedVoid.headers?.get("Idempotency-Key")).toBeTruthy();
	});

	it("does not offer edit or void buttons for VOIDED transactions", async () => {
		const voidedTx = {
			...mockTx,
			status: "VOIDED",
		};

		global.fetch = vi.fn().mockImplementation((url: string) => {
			if (url.includes("/transactions/tx-void-test-1/revisions")) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							transactionId: "tx-void-test-1",
							revisions: mockRevisions,
							nextCursor: null,
						}),
					headers: new Headers({ "content-type": "application/json" }),
				});
			}
			if (url.includes("/transactions/tx-void-test-1")) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve(voidedTx),
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
				<TransactionDetailDrawer
					transactionId="tx-void-test-1"
					isOpen={true}
					onClose={vi.fn()}
				/>
			</QueryClientProvider>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("detail-content")).toBeInTheDocument();
		});

		expect(screen.queryByTestId("detail-void-btn")).not.toBeInTheDocument();
		expect(screen.queryByTestId("detail-edit-btn")).not.toBeInTheDocument();
		expect(screen.getByTestId("detail-voided-badge")).toBeInTheDocument();
	});
});

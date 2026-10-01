import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as f7Api from "../src/api/f7-api";
import type { LongTermTaskProductDto } from "../src/api/f7-types";
import { LongTermLifecycleModal } from "../src/components/long-term/LongTermLifecycleModal";
import { LongTermTaskForm } from "../src/components/long-term/LongTermTaskForm";

vi.mock("../src/api/f7-api");

// Mock tanstack router Link and useNavigate
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to, ...props }: any) => (
		<a href={to} {...props}>
			{children}
		</a>
	),
	useNavigate: () => vi.fn(),
}));

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return {
		queryClient,
		wrapper: ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		),
	};
}

const mockPendingTask: LongTermTaskProductDto = {
	taskId: "task-1",
	status: "PENDING",
	revisionNo: 3,
	amount: "600.00",
	destinationLabel: "İnteraktif Yatırım",
	note: "Aylık fon yatırımı",
	midasAccountId: "midas-1",
	pendingBucketId: "b-pending-1",
	allocatedAt: "2026-03-29T10:00:00Z",
	sentAt: null,
	latestMidasAllocationTransferId: "tr-alloc-1",
	currentSendCanonicalTransactionId: null,
	currentSendCanonicalRevisionId: null,
	createdAt: "2026-03-29T10:00:00Z",
};

const mockSentTask: LongTermTaskProductDto = {
	...mockPendingTask,
	status: "SENT",
	revisionNo: 4,
	sentAt: "2026-03-29T12:00:00Z",
	currentSendCanonicalTransactionId: "tx-canonical-1",
	currentSendCanonicalRevisionId: "rev-1",
};

describe("Phase F7 — Long-Term Investment Tasks", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it("Section 81: creates task when amount <= unallocatedBalance, blocks 1000.01 before POST", async () => {
		vi.spyOn(f7Api, "fetchMidasLiquidity").mockResolvedValue({
			liquidity: {
				midasAccountId: "midas-1",
				ledgerAccountId: "acc-1",
				currency: "TRY",
				physicalBalance: "5000.00",
				totalEarmarked: "4000.00",
				unallocatedBalance: "1000.00",
				buckets: [],
			},
		});

		const mockCreate = vi.spyOn(f7Api, "createLongTermTask").mockResolvedValue({
			task: mockPendingTask,
		});

		const onSuccess = vi.fn();
		const { wrapper } = createWrapper();
		render(<LongTermTaskForm onSuccess={onSuccess} />, { wrapper });

		// Wait for unallocated balance to load (1.000,00 TL)
		expect(
			await screen.findByTestId("form-unallocated-balance"),
		).toHaveTextContent("₺1.000,00");

		const amountInput = screen.getByTestId("money-input");
		const destInput = screen.getByTestId("destination-label-input");
		const submitBtn = screen.getByTestId("task-submit-btn");

		// 1. Try amount 1000.01 -> blocked before POST
		fireEvent.change(amountInput, { target: { value: "1000,01" } });
		fireEvent.change(destInput, { target: { value: "İnteraktif Yatırım" } });
		fireEvent.click(submitBtn);

		expect(
			await screen.findByText(/Tutar Midas serbest bakiyesini.*aşamaz/i),
		).toBeInTheDocument();
		expect(mockCreate).not.toHaveBeenCalled();

		// 2. Try valid amount 600.00 -> allowed
		fireEvent.change(amountInput, { target: { value: "600,00" } });
		fireEvent.click(submitBtn);

		await waitFor(() => {
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					midasAccountId: "midas-1",
					amount: "600.00",
					destinationLabel: "İnteraktif Yatırım",
				}),
				expect.any(String), // Idempotency-Key
			);
			expect(onSuccess).toHaveBeenCalledWith(mockPendingTask);
		});
	});

	it("Section 82: mark-sent records physical send with fresh OCC revisionNo and invalidates financial queries", async () => {
		const mockMarkSent = vi
			.spyOn(f7Api, "markSentLongTermTask")
			.mockResolvedValue({
				task: mockSentTask,
			});

		const { queryClient, wrapper } = createWrapper();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		render(
			<LongTermLifecycleModal
				isOpen={true}
				onClose={vi.fn()}
				task={mockPendingTask} // revisionNo = 3
				actionType="mark-sent"
			/>,
			{ wrapper },
		);

		// Explanation copy explains physical movement
		expect(
			screen.getByText(/fiziksel olarak gönderildiğini kaydeder/i),
		).toBeInTheDocument();

		// Submit mark-sent
		const submitBtn = screen.getByTestId("lifecycle-submit-btn");
		fireEvent.click(submitBtn);

		await waitFor(() => {
			expect(mockMarkSent).toHaveBeenCalledWith(
				"task-1",
				expect.objectContaining({
					expectedRevisionNo: 3, // revisionNo is 3
					occurredAt: expect.any(String),
				}),
				expect.any(String),
			);
		});

		// Check query invalidations
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["long-term-tasks"],
		});
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["long-term-task", "task-1"],
		});
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["midas-liquidity"],
		});
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["midas-transfers"],
		});
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["transactions"],
		});
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["ledger-accounts"],
		});
	});

	it("Section 83: reopen flow transitions SENT task back to PENDING with fresh OCC", async () => {
		const mockReopen = vi.spyOn(f7Api, "reopenLongTermTask").mockResolvedValue({
			task: {
				...mockPendingTask,
				revisionNo: 5,
			},
		});

		const { wrapper } = createWrapper();
		render(
			<LongTermLifecycleModal
				isOpen={true}
				onClose={vi.fn()}
				task={mockSentTask} // revisionNo = 4
				actionType="reopen"
			/>,
			{ wrapper },
		);

		// Explanation copy for reopen
		expect(
			screen.getByText(/muhasebe etkisi tersine çevrilir/i),
		).toBeInTheDocument();

		const reasonInput = screen.getByTestId("lifecycle-reason-note-input");
		fireEvent.change(reasonInput, { target: { value: "Yanlış işaretleme" } });

		const submitBtn = screen.getByTestId("lifecycle-submit-btn");
		fireEvent.click(submitBtn);

		await waitFor(() => {
			expect(mockReopen).toHaveBeenCalledWith(
				"task-1",
				expect.objectContaining({
					expectedRevisionNo: 4,
					reasonNote: "Yanlış işaretleme",
				}),
				expect.any(String),
			);
		});
	});

	it("Section 84: cancel transitions PENDING task to CANCELLED returning earmark to unallocated balance", async () => {
		const mockCancel = vi.spyOn(f7Api, "cancelLongTermTask").mockResolvedValue({
			task: {
				...mockPendingTask,
				status: "CANCELLED",
				revisionNo: 4,
			},
		});

		const { queryClient, wrapper } = createWrapper();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		render(
			<LongTermLifecycleModal
				isOpen={true}
				onClose={vi.fn()}
				task={mockPendingTask} // revisionNo = 3
				actionType="cancel"
			/>,
			{ wrapper },
		);

		// Confirmation copy
		expect(
			screen.getByText(/Midas Serbest Bakiye'ye iade edilir/i),
		).toBeInTheDocument();

		const submitBtn = screen.getByTestId("lifecycle-submit-btn");
		fireEvent.click(submitBtn);

		await waitFor(() => {
			expect(mockCancel).toHaveBeenCalledWith(
				"task-1",
				expect.objectContaining({
					expectedRevisionNo: 3,
				}),
				expect.any(String),
			);
		});

		// Verifies Midas liquidity refetched
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["midas-liquidity"],
		});
	});
});

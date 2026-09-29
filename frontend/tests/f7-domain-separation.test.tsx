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
import type {
	LongTermTaskProductDto,
	ShortTermGoalProductDto,
} from "../src/api/f7-types";
import { GoalFundingModal } from "../src/components/goals/GoalFundingModal";
import { LongTermTaskForm } from "../src/components/long-term/LongTermTaskForm";
import { MidasPage } from "../src/components/midas/MidasPage";

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

const mockGoal: ShortTermGoalProductDto = {
	goalId: "goal-domain-1",
	midasAccountId: "midas-1",
	midasBucketId: "b-goal-1",
	status: "ACTIVE",
	name: "Hedef",
	fundingTarget: "1000.00",
	accumulatedAmount: "400.00",
	remainingToTarget: "600.00",
	fundingStatus: "PARTIAL",
	progressPercentage: 40,
	targetDate: null,
	maxBudget: null,
	targetPrice: null,
	productUrl: null,
	note: null,
	priority: 1,
	latestRevisionNo: 1,
	createdAt: "2026-03-29T10:00:00Z",
	updatedAt: "2026-03-29T10:00:00Z",
};

describe("Phase F7 — Domain Separation & Anti-Bypass Invariants", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it("Section 79: Short-Term Goal funding/release strictly calls goal endpoints, NEVER generic /midas/transfers", async () => {
		const midasTransferSpy = vi.spyOn(f7Api, "createMidasTransfer");
		const fundGoalSpy = vi.spyOn(f7Api, "fundShortTermGoal").mockResolvedValue({
			funding: {
				goalId: "goal-domain-1",
				midasAccountId: "midas-1",
				midasBucketId: "b-goal-1",
				transferId: "tr-fund-1",
				amount: "200.00",
				occurredAt: "2026-03-29T10:00:00Z",
			},
		});
		const releaseGoalSpy = vi
			.spyOn(f7Api, "releaseShortTermGoal")
			.mockResolvedValue({
				release: {
					goalId: "goal-domain-1",
					midasAccountId: "midas-1",
					midasBucketId: "b-goal-1",
					transferId: "tr-rel-1",
					amount: "200.00",
					occurredAt: "2026-03-29T10:00:00Z",
				},
			});

		const { wrapper } = createWrapper();

		// 1. Fund
		const { rerender } = render(
			<GoalFundingModal
				isOpen={true}
				onClose={vi.fn()}
				goal={mockGoal}
				unallocatedBalance="2000.00"
				mode="fund"
			/>,
			{ wrapper },
		);

		const amountInput = screen.getByTestId("money-input");
		fireEvent.change(amountInput, { target: { value: "200,00" } });
		fireEvent.click(screen.getByTestId("goal-funding-submit-btn"));

		await waitFor(() => {
			expect(fundGoalSpy).toHaveBeenCalled();
			expect(midasTransferSpy).not.toHaveBeenCalled();
		});

		// 2. Release
		rerender(
			<GoalFundingModal
				isOpen={true}
				onClose={vi.fn()}
				goal={mockGoal}
				unallocatedBalance="2000.00"
				mode="release"
			/>,
		);

		fireEvent.change(screen.getByTestId("money-input"), {
			target: { value: "200,00" },
		});
		fireEvent.click(screen.getByTestId("goal-funding-submit-btn"));

		await waitFor(() => {
			expect(releaseGoalSpy).toHaveBeenCalled();
			expect(midasTransferSpy).not.toHaveBeenCalled();
		});
	});

	it("Section 79: Long-Term task creation strictly calls task endpoint, NEVER generic /midas/transfers", async () => {
		const midasTransferSpy = vi.spyOn(f7Api, "createMidasTransfer");
		const taskCreateSpy = vi
			.spyOn(f7Api, "createLongTermTask")
			.mockResolvedValue({
				task: {
					taskId: "task-new",
					status: "PENDING",
					revisionNo: 1,
					amount: "300.00",
					destinationLabel: "BIST",
					note: null,
					midasAccountId: "midas-1",
					pendingBucketId: "b-pending",
					allocatedAt: "2026-03-29T10:00:00Z",
					sentAt: null,
					latestMidasAllocationTransferId: "tr-1",
					currentSendCanonicalTransactionId: null,
					currentSendCanonicalRevisionId: null,
					createdAt: "2026-03-29T10:00:00Z",
				},
			});

		vi.spyOn(f7Api, "fetchMidasLiquidity").mockResolvedValue({
			liquidity: {
				midasAccountId: "midas-1",
				ledgerAccountId: "acc-1",
				currency: "TRY",
				physicalBalance: "5000.00",
				totalEarmarked: "1000.00",
				unallocatedBalance: "4000.00",
				buckets: [],
			},
		});

		const { wrapper } = createWrapper();
		render(<LongTermTaskForm onSuccess={vi.fn()} />, { wrapper });

		await waitFor(() => {
			expect(
				screen.getByTestId("form-unallocated-balance"),
			).toBeInTheDocument();
		});

		fireEvent.change(screen.getByTestId("money-input"), {
			target: { value: "300,00" },
		});
		fireEvent.click(screen.getByTestId("task-submit-btn"));

		await waitFor(() => {
			expect(taskCreateSpy).toHaveBeenCalled();
			expect(midasTransferSpy).not.toHaveBeenCalled();
		});
	});

	it("Section 18 & 22: MidasPage exposes manual allocate/release ONLY for CREDIT_CARD_RESERVE, not Goal or Long-Term buckets", async () => {
		vi.spyOn(f7Api, "fetchMidasLiquidity").mockResolvedValue({
			liquidity: {
				midasAccountId: "midas-1",
				ledgerAccountId: "acc-1",
				currency: "TRY",
				physicalBalance: "10000.00",
				totalEarmarked: "6500.00",
				unallocatedBalance: "3500.00",
				buckets: [
					{
						bucketId: "b-card",
						code: "CARD_RES_1",
						name: "Garanti Bonus Rezervi",
						bucketType: "CREDIT_CARD_RESERVE",
						balance: "2500.00",
					},
					{
						bucketId: "b-goal",
						code: "GOAL_1",
						name: "Tatil Fonu",
						bucketType: "SHORT_TERM_GOAL",
						balance: "3000.00",
					},
					{
						bucketId: "b-long",
						code: "LONG_1",
						name: "Uzun Vadeli",
						bucketType: "PENDING_LONG_TERM",
						balance: "1000.00",
					},
				],
			},
		});
		vi.spyOn(f7Api, "fetchMidasTransfers").mockResolvedValue({
			transfers: [],
			limit: 50,
			hasMore: false,
			nextCursor: null,
		});

		const { wrapper } = createWrapper();
		render(<MidasPage />, { wrapper });

		// Card reserve bucket HAS "Rezervi Artır" and "Serbeste Aktar" buttons
		expect(
			await screen.findByTestId("btn-allocate-b-card"),
		).toBeInTheDocument();
		expect(screen.getByTestId("btn-release-b-card")).toBeInTheDocument();

		// Goal and Long-term buckets do NOT expose generic transfer buttons
		expect(screen.queryByTestId("btn-allocate-b-goal")).toBeNull();
		expect(screen.queryByTestId("btn-release-b-goal")).toBeNull();
		expect(screen.queryByTestId("btn-allocate-b-long")).toBeNull();
		expect(screen.queryByTestId("btn-release-b-long")).toBeNull();

		// Instead, they link to their respective domain pages
		expect(screen.getByTestId("link-to-goals")).toHaveAttribute(
			"href",
			"/goals",
		);
		expect(screen.getByTestId("link-to-long-term")).toHaveAttribute(
			"href",
			"/long-term",
		);
	});
});

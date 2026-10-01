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
import { ApiError } from "../../frontend/src/api/errors";
import * as f7Api from "../src/api/f7-api";
import type { ShortTermGoalProductDto } from "../src/api/f7-types";
import { GoalDetailPage } from "../src/components/goals/GoalDetailPage";
import { GoalForm } from "../src/components/goals/GoalForm";
import { GoalFundingModal } from "../src/components/goals/GoalFundingModal";
import { GoalsPage } from "../src/components/goals/GoalsPage";

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

const mockGoalBase: ShortTermGoalProductDto = {
	goalId: "goal-1",
	midasAccountId: "midas-1",
	midasBucketId: "b-goal-1",
	status: "ACTIVE",
	name: "Yeni Laptop",
	fundingTarget: "1000.00",
	accumulatedAmount: "900.00",
	remainingToTarget: "100.00",
	fundingStatus: "PARTIAL",
	progressPercentage: 90,
	targetDate: "2026-06-30",
	maxBudget: "1500.00",
	targetPrice: "1200.00",
	productUrl: "https://example.com/laptop",
	note: "Yazılım geliştirme için",
	priority: 1,
	latestRevisionNo: 3,
	createdAt: "2026-03-29T10:00:00Z",
	updatedAt: "2026-03-29T10:00:00Z",
};

describe("Phase F7 — Short-Term Goals", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it("Section 74: fund cap is maxBudget minus accumulated, NOT remaining-to-target", async () => {
		const mockFund = vi.spyOn(f7Api, "fundShortTermGoal").mockResolvedValue({
			funding: {
				goalId: "goal-1",
				transferId: "tr-1",
				amount: "200.00",
				idempotentReplay: false,
			},
			idempotentReplay: false,
		});

		const { wrapper } = createWrapper();

		// goal: fundingTarget=1000.00, accumulated=900.00, maxBudget=1500.00, unallocated=1000.00
		// remaining cap: 1500 - 900 = 600.00
		const { rerender } = render(
			<GoalFundingModal
				isOpen={true}
				onClose={vi.fn()}
				goal={mockGoalBase}
				unallocatedBalance="1000.00"
				mode="fund"
			/>,
			{ wrapper },
		);

		// Limit shows 600,00 TL (not 100,00 TL remaining-to-target)
		expect(screen.getByText(/₺600,00/i)).toBeInTheDocument();

		// 1. Try funding 601,00 -> blocked before calling API
		const amountInput = screen.getByTestId("money-input");
		fireEvent.change(amountInput, { target: { value: "601,00" } });
		fireEvent.click(screen.getByTestId("goal-funding-submit-btn"));

		expect(
			await screen.findByText(/Aktarılabilecek azami tutar: ₺600,00/i),
		).toBeInTheDocument();
		expect(mockFund).not.toHaveBeenCalled();

		// 2. Fund 200,00 -> allowed (exceeds fundingTarget 1000, but <= maxBudget 1500)
		fireEvent.change(amountInput, { target: { value: "200,00" } });
		fireEvent.click(screen.getByTestId("goal-funding-submit-btn"));

		await waitFor(() => {
			expect(mockFund).toHaveBeenCalledWith(
				"goal-1",
				expect.objectContaining({
					amount: "200.00",
					fromBucketId: null,
				}),
				expect.any(String),
			);
		});

		// 3. Fund 600,00 -> exactly reaches maxBudget -> allowed
		mockFund.mockClear();
		fireEvent.change(amountInput, { target: { value: "600,00" } });
		fireEvent.click(screen.getByTestId("goal-funding-submit-btn"));

		await waitFor(() => {
			expect(mockFund).toHaveBeenCalledWith(
				"goal-1",
				expect.objectContaining({
					amount: "600.00",
					fromBucketId: null,
				}),
				expect.any(String),
			);
		});
	});

	it("Section 75: goal without maxBudget allows funding beyond target up to unallocated balance", async () => {
		const mockFund = vi.spyOn(f7Api, "fundShortTermGoal").mockResolvedValue({
			funding: {
				goalId: "goal-1",
				transferId: "tr-1",
				amount: "200.00",
				idempotentReplay: false,
			},
			idempotentReplay: false,
		});

		const goalWithoutMaxBudget: ShortTermGoalProductDto = {
			...mockGoalBase,
			maxBudget: null,
			fundingTarget: "1000.00",
			accumulatedAmount: "900.00",
		};

		const { wrapper } = createWrapper();
		render(
			<GoalFundingModal
				isOpen={true}
				onClose={vi.fn()}
				goal={goalWithoutMaxBudget}
				unallocatedBalance="500.00"
				mode="fund"
			/>,
			{ wrapper },
		);

		// Limit is unallocated balance 500.00 TL
		expect(screen.getByText(/Azami: ₺500,00/i)).toBeInTheDocument();

		// Funding 200.00 is allowed even though 900 + 200 = 1100 > fundingTarget 1000
		const amountInput = screen.getByTestId("money-input");
		fireEvent.change(amountInput, { target: { value: "200,00" } });
		fireEvent.click(screen.getByTestId("goal-funding-submit-btn"));

		await waitFor(() => {
			expect(mockFund).toHaveBeenCalledWith(
				"goal-1",
				expect.objectContaining({
					amount: "200.00",
					fromBucketId: null,
				}),
				expect.any(String),
			);
		});
	});

	it("Section 76: completion & cancellation require zero bucket balance and execute with fresh latestRevisionNo", async () => {
		const mockComplete = vi
			.spyOn(f7Api, "completeShortTermGoal")
			.mockResolvedValue({
				goal: {
					...mockGoalBase,
					accumulatedAmount: "0.00",
					status: "COMPLETED",
				},
			});

		// 1. Goal with non-zero accumulated balance (900.00)
		vi.spyOn(f7Api, "fetchShortTermGoal").mockResolvedValue({
			goal: mockGoalBase, // accumulatedAmount = "900.00"
		});
		vi.spyOn(f7Api, "fetchMidasLiquidity").mockResolvedValue({
			liquidity: {
				midasAccountId: "midas-1",
				ledgerAccountId: "acc-1",
				currency: "TRY",
				physicalBalance: "10000.00",
				totalEarmarked: "900.00",
				unallocatedBalance: "9100.00",
				buckets: [],
			},
		});

		const { wrapper } = createWrapper();
		render(<GoalDetailPage goalId="goal-1" />, { wrapper });

		// Both complete and cancel buttons must be disabled
		const completeBtn = await screen.findByTestId("goal-complete-btn");
		const cancelBtn = screen.getByTestId("goal-cancel-btn");
		expect(completeBtn).toBeDisabled();
		expect(cancelBtn).toBeDisabled();

		// Guidance message shown
		expect(
			screen.getByText(
				/Hedefi tamamlamak veya iptal etmek için önce içindeki/i,
			),
		).toBeInTheDocument();

		cleanup();

		// 2. Goal with zero accumulated balance (0.00)
		vi.spyOn(f7Api, "fetchShortTermGoal").mockResolvedValue({
			goal: {
				...mockGoalBase,
				accumulatedAmount: "0.00",
				remainingToTarget: "1000.00",
				latestRevisionNo: 5,
			},
		});

		const { wrapper: zeroWrapper } = createWrapper();
		render(<GoalDetailPage goalId="goal-1" />, { wrapper: zeroWrapper });

		const enabledCompleteBtn = await screen.findByTestId("goal-complete-btn");
		expect(enabledCompleteBtn).not.toBeDisabled();

		fireEvent.click(enabledCompleteBtn);

		await waitFor(() => {
			expect(mockComplete).toHaveBeenCalledWith(
				"goal-1",
				expect.objectContaining({
					expectedRevisionNo: 5, // Fresh revision number
				}),
				expect.any(String),
			);
		});
	});

	it("Section 77 & 78: priority reorder fetches COMPLETE set of ACTIVE goals across pages and retries with frozen attempt", async () => {
		// Mock pagination: page 1 returns [goal-A, goal-B] with nextCursor "c2"
		// page 2 returns [goal-C] with nextCursor null
		const goalA: ShortTermGoalProductDto = {
			...mockGoalBase,
			goalId: "goal-A",
			name: "A",
			priority: 1,
		};
		const goalB: ShortTermGoalProductDto = {
			...mockGoalBase,
			goalId: "goal-B",
			name: "B",
			priority: 2,
		};
		const goalC: ShortTermGoalProductDto = {
			...mockGoalBase,
			goalId: "goal-C",
			name: "C",
			priority: 3,
		};

		vi.spyOn(f7Api, "fetchMidasLiquidity").mockResolvedValue({
			liquidity: {
				midasAccountId: "midas-1",
				ledgerAccountId: "acc-1",
				currency: "TRY",
				physicalBalance: "10000.00",
				totalEarmarked: "0.00",
				unallocatedBalance: "10000.00",
				buckets: [],
			},
		});

		vi.spyOn(f7Api, "fetchShortTermGoals").mockResolvedValue({
			goals: [goalA, goalB],
			nextCursor: "c2",
			hasMore: true,
			limit: 50,
		});

		const mockFetchAllActive = vi
			.spyOn(f7Api, "fetchAllActiveShortTermGoals")
			.mockResolvedValue([goalA, goalB, goalC]);

		let capturedKey: string | null = null;
		let capturedOccurredAt: string | null = null;

		// First reorder call fails with network uncertainty
		const mockReorder = vi
			.spyOn(f7Api, "reorderShortTermGoals")
			.mockImplementationOnce(async (payload, key) => {
				capturedKey = key;
				capturedOccurredAt = payload.occurredAt;
				throw new ApiError({
					status: 0,
					code: "NETWORK_ERROR",
					message: "Network drop",
				});
			})
			.mockResolvedValueOnce({
				reorder: {
					priorityRevisionId: "rev-123",
					revisionNo: 1,
					orderedGoalIds: ["goal-B", "goal-A", "goal-C"],
					idempotentReplay: false,
				},
				idempotentReplay: false,
			});

		const { wrapper } = createWrapper();
		render(<GoalsPage />, { wrapper });

		// Click "Sıralamayı Düzenle"
		const startReorderBtn = await screen.findByTestId("start-reorder-btn");
		fireEvent.click(startReorderBtn);

		// Assert fetchAllActiveShortTermGoals was called to fetch the complete set
		await waitFor(() => {
			expect(mockFetchAllActive).toHaveBeenCalledWith("midas-1");
		});

		// Move goal-A down (so order becomes B, A, C)
		const moveDownBtnA = await screen.findByTestId("move-down-goal-A");
		fireEvent.click(moveDownBtnA);

		// Click "Sıralamayı Kaydet"
		const saveReorderBtn = screen.getByTestId("save-reorder-btn");
		fireEvent.click(saveReorderBtn);

		// First attempt fails uncertain
		await waitFor(() => {
			expect(mockReorder).toHaveBeenCalledTimes(1);
			expect(
				screen.getByText(
					/Sıralama kaydının tamamlanıp tamamlanmadığı doğrulanamadı/i,
				),
			).toBeInTheDocument();
		});

		// Section 78: Click explicit retry button
		const retryBtn = screen.getByTestId("retry-uncertain-btn");
		fireEvent.click(retryBtn);

		await waitFor(() => {
			expect(mockReorder).toHaveBeenCalledTimes(2);
		});

		// Verify frozen key, payload, and occurredAt are strictly reused on retry
		const secondCallPayload = mockReorder.mock.calls[1]?.[0];
		const secondCallKey = mockReorder.mock.calls[1]?.[1];

		expect(secondCallKey).toBe(capturedKey);
		expect(secondCallPayload?.occurredAt).toBe(capturedOccurredAt);
		expect(secondCallPayload?.orderedGoalIds).toEqual([
			"goal-B",
			"goal-A",
			"goal-C",
		]);
	});

	it("Section 35: GoalForm in edit mode pre-fills goal.fundingTarget (NOT remainingToTarget)", async () => {
		// Mock goal where fundingTarget=1000.00 and remainingToTarget=200.00
		const goalWithRemaining: ShortTermGoalProductDto = {
			...mockGoalBase,
			fundingTarget: "1000.00",
			accumulatedAmount: "800.00",
			remainingToTarget: "200.00",
		};

		vi.spyOn(f7Api, "fetchShortTermGoal").mockResolvedValue({
			goal: goalWithRemaining,
		});

		const { wrapper } = createWrapper();
		render(<GoalForm mode="edit" goalId="goal-1" />, { wrapper });

		// Input for Hedef Tutar must show "1000.00", NOT "200.00"
		await waitFor(() => {
			const targetInput = screen.getByLabelText(/Hedef Tutar/i);
			expect(targetInput).toHaveValue("1000.00");
			expect(targetInput).not.toHaveValue("200.00");
		});
	});

	it("R1 regression: GoalForm create mode differentiates generic liquidity failure from NOT_CONFIGURED", async () => {
		// 1. Generic 500 failure
		vi.spyOn(f7Api, "fetchMidasLiquidity").mockRejectedValue(
			new ApiError({
				status: 500,
				code: "INTERNAL_ERROR",
				message: "Server error",
			}),
		);

		const { wrapper: errorWrapper } = createWrapper();
		render(<GoalForm mode="create" />, { wrapper: errorWrapper });

		// Assert authority-error guard is shown, NOT setup CTA
		expect(
			await screen.findByTestId("midas-authority-error-guard"),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/Yeni hedef oluşturulmadan önce Midas likidite durumu doğrulanmalıdır/i,
			),
		).toBeInTheDocument();
		expect(screen.queryByTestId("midas-not-configured-guard")).toBeNull();
		expect(screen.queryByTestId("goal-form")).toBeNull();

		cleanup();

		// 2. Exact 404 MIDAS_ACCOUNT_NOT_FOUND
		vi.spyOn(f7Api, "fetchMidasLiquidity").mockRejectedValue(
			new ApiError({
				status: 404,
				code: "MIDAS_ACCOUNT_NOT_FOUND",
				message: "Not found",
			}),
		);

		const { wrapper: setupWrapper } = createWrapper();
		render(<GoalForm mode="create" />, { wrapper: setupWrapper });

		// Assert setup CTA is shown, NOT authority-error guard
		expect(
			await screen.findByTestId("midas-not-configured-guard"),
		).toBeInTheDocument();
		expect(screen.getByText(/Midas'ı Kur/i)).toBeInTheDocument();
		expect(screen.queryByTestId("midas-authority-error-guard")).toBeNull();
	});

	it("R1 regression: GoalDetailPage when liquidity query fails does not invent ₺0,00 and disables funding with authority error", async () => {
		vi.spyOn(f7Api, "fetchShortTermGoal").mockResolvedValue({
			goal: mockGoalBase,
		});
		vi.spyOn(f7Api, "fetchMidasLiquidity").mockRejectedValue(
			new ApiError({
				status: 500,
				code: "INTERNAL_ERROR",
				message: "Midas service down",
			}),
		);

		const { wrapper } = createWrapper();
		render(<GoalDetailPage goalId="goal-1" />, { wrapper });

		// Wait for goal to load
		await screen.findByText("Yeni Laptop");

		// No fake "Serbest Midas Bakiye ₺0,00" displayed
		expect(screen.queryByText(/Serbest Midas Bakiye: ₺0,00/i)).toBeNull();

		// Fund action button must be disabled
		const fundBtn = screen.getByTestId("open-fund-modal-btn");
		expect(fundBtn).toBeDisabled();

		// Explicit authority error alert must be visible with retry button
		expect(
			screen.getByTestId("midas-authority-error-alert"),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/Midas serbest bakiye durumu doğrulanamadığı için fonlama işlemi yapılamaz/i,
			),
		).toBeInTheDocument();
	});

	it("R2 regression: reorder, funding, and release responses match exact backend source DTO contract", async () => {
		// Mock reorder response exactly matching backend
		const _mockReorder = vi
			.spyOn(f7Api, "reorderShortTermGoals")
			.mockResolvedValue({
				reorder: {
					priorityRevisionId: "rev-uuid-1",
					revisionNo: 2,
					orderedGoalIds: ["goal-1", "goal-2"],
					idempotentReplay: false,
				},
				idempotentReplay: false,
			});

		const reorderRes = await f7Api.reorderShortTermGoals(
			{
				midasAccountId: "midas-1",
				orderedGoalIds: ["goal-1", "goal-2"],
				occurredAt: "2026-03-29T10:00:00Z",
			},
			"key-1",
		);

		// Assert priorityRevisionId exists on reorder and fictional fields are absent
		expect(reorderRes.reorder.priorityRevisionId).toBe("rev-uuid-1");
		expect(reorderRes.reorder.revisionNo).toBe(2);
		expect(reorderRes.reorder.orderedGoalIds).toEqual(["goal-1", "goal-2"]);
		expect(reorderRes.reorder.idempotentReplay).toBe(false);
		expect((reorderRes.reorder as any).midasAccountId).toBeUndefined();
		expect((reorderRes.reorder as any).occurredAt).toBeUndefined();

		// Mock fund response exactly matching backend
		const _mockFund = vi.spyOn(f7Api, "fundShortTermGoal").mockResolvedValue({
			funding: {
				goalId: "goal-1",
				transferId: "tr-1",
				amount: "150.00",
				idempotentReplay: false,
			},
			idempotentReplay: false,
		});

		const fundRes = await f7Api.fundShortTermGoal(
			"goal-1",
			{ amount: "150.00", occurredAt: "2026-03-29T10:00:00Z" },
			"key-2",
		);

		// Assert only actual backend fields exist on funding
		expect(fundRes.funding.goalId).toBe("goal-1");
		expect(fundRes.funding.transferId).toBe("tr-1");
		expect(fundRes.funding.amount).toBe("150.00");
		expect(fundRes.funding.idempotentReplay).toBe(false);
		expect((fundRes.funding as any).midasAccountId).toBeUndefined();
		expect((fundRes.funding as any).midasBucketId).toBeUndefined();
		expect((fundRes.funding as any).occurredAt).toBeUndefined();

		// Mock release response exactly matching backend
		const _mockRelease = vi
			.spyOn(f7Api, "releaseShortTermGoal")
			.mockResolvedValue({
				release: {
					goalId: "goal-1",
					transferId: "tr-2",
					amount: "150.00",
					idempotentReplay: false,
				},
				idempotentReplay: false,
			});

		const releaseRes = await f7Api.releaseShortTermGoal(
			"goal-1",
			{ amount: "150.00", occurredAt: "2026-03-29T10:00:00Z" },
			"key-3",
		);

		// Assert only actual backend fields exist on release
		expect(releaseRes.release.goalId).toBe("goal-1");
		expect(releaseRes.release.transferId).toBe("tr-2");
		expect(releaseRes.release.amount).toBe("150.00");
		expect(releaseRes.release.idempotentReplay).toBe(false);
		expect((releaseRes.release as any).midasAccountId).toBeUndefined();
		expect((releaseRes.release as any).midasBucketId).toBeUndefined();
		expect((releaseRes.release as any).occurredAt).toBeUndefined();
	});
});

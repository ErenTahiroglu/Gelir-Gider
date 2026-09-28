import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dashboardApi from "../src/api/dashboard-api";
import type {
	BudgetV2CheckpointTimeline,
	BudgetV2DecisionCenterView,
} from "../src/api/dashboard-types";
import { HeroAvailableSpend } from "../src/components/dashboard/HeroAvailableSpend";
import * as istanbulDate from "../src/lib/istanbul-date";

function renderWithQuery(ui: React.ReactElement) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
		},
	});
	return render(
		<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
	);
}

describe("Dashboard Hero Available Spend — Budget V2 Authority & Fail-Closed Invariants", () => {
	const currentMonth = "2026-09";

	beforeEach(() => {
		vi.restoreAllMocks();
		vi.spyOn(istanbulDate, "getIstanbulPeriodMonth").mockReturnValue(
			currentMonth,
		);
	});

	it("renders exact amount when available: true (does not render trueSurplus)", async () => {
		const timeline: BudgetV2CheckpointTimeline = {
			apiVersion: "budget-v2-product-api-v1",
			limit: 50,
			sharedMaxCheckpointAt: false,
			checkpoints: [
				{
					paymentEventId: "ev-1111-2222-3333-4444",
					checkpointAt: "2026-09-15T10:00:00Z",
					periodMonth: currentMonth,
				},
			],
		};

		const decisionCenter: BudgetV2DecisionCenterView = {
			apiVersion: "budget-v2-product-api-v1",
			target: {
				paymentEventId: "ev-1111-2222-3333-4444",
				checkpointAt: "2026-09-15T10:00:00Z",
				periodMonth: currentMonth,
			},
			checkpoint: {
				temporalScope: "FROZEN_AT_CHECKPOINT",
				report: {
					availableToAllocateNow: {
						available: true,
						amount: "14250.00",
						trueSurplus: "99999.00",
					},
				},
			},
		};

		vi.spyOn(dashboardApi, "fetchBudgetCheckpoints").mockResolvedValue(
			timeline,
		);
		vi.spyOn(dashboardApi, "fetchBudgetDecisionCenter").mockResolvedValue(
			decisionCenter,
		);

		renderWithQuery(<HeroAvailableSpend isUnlocked={true} />);

		expect(await screen.findByText("₺14.250,00")).toBeInTheDocument();
		expect(screen.getByText("Doğrulandı")).toBeInTheDocument();
		expect(screen.queryByText("₺99.999,00")).not.toBeInTheDocument();
		expect(screen.queryByText("0,00 ₺")).not.toBeInTheDocument();
	});

	it("renders unconfirmed state when available: false with SURPLUS_USE_ATTRIBUTION_INCOMPLETE", async () => {
		const timeline: BudgetV2CheckpointTimeline = {
			apiVersion: "budget-v2-product-api-v1",
			limit: 50,
			sharedMaxCheckpointAt: false,
			checkpoints: [
				{
					paymentEventId: "ev-1111-2222-3333-4444",
					checkpointAt: "2026-09-15T10:00:00Z",
					periodMonth: currentMonth,
				},
			],
		};

		const decisionCenter: BudgetV2DecisionCenterView = {
			apiVersion: "budget-v2-product-api-v1",
			target: {
				paymentEventId: "ev-1111-2222-3333-4444",
				checkpointAt: "2026-09-15T10:00:00Z",
				periodMonth: currentMonth,
			},
			checkpoint: {
				temporalScope: "FROZEN_AT_CHECKPOINT",
				report: {
					availableToAllocateNow: {
						available: false,
						reason: "SURPLUS_USE_ATTRIBUTION_INCOMPLETE",
						trueSurplus: "99999.00",
						candidateCount: 2,
						attributedCount: 1,
						unattributedSubjectIds: ["sub-1"],
						staleSubjectIds: [],
						overlapUnresolvedSubjectIds: [],
						knownAttributedCurrentSurplusUse: "100.00",
						unresolvedPotentialUseAmount: "200.00",
					},
				},
			},
		};

		vi.spyOn(dashboardApi, "fetchBudgetCheckpoints").mockResolvedValue(
			timeline,
		);
		vi.spyOn(dashboardApi, "fetchBudgetDecisionCenter").mockResolvedValue(
			decisionCenter,
		);

		renderWithQuery(<HeroAvailableSpend isUnlocked={true} />);

		expect(
			await screen.findByText("Kullanılabilir tutar henüz kesinleşmedi"),
		).toBeInTheDocument();

		// STRICT INVARIANTS: NEVER render 0 TL, 0,00 ₺, trueSurplus, or raw internal reason code
		expect(screen.queryByText("0 TL")).not.toBeInTheDocument();
		expect(screen.queryByText("0,00 ₺")).not.toBeInTheDocument();
		expect(screen.queryByText("₺0,00")).not.toBeInTheDocument();
		expect(screen.queryByText("₺99.999,00")).not.toBeInTheDocument();
		expect(
			screen.queryByText("SURPLUS_USE_ATTRIBUTION_INCOMPLETE"),
		).not.toBeInTheDocument();
	});

	it("renders unconfirmed state when available: false with SURPLUS_USE_ATTRIBUTION_OVERLAP_UNRESOLVED", async () => {
		const timeline: BudgetV2CheckpointTimeline = {
			apiVersion: "budget-v2-product-api-v1",
			limit: 50,
			sharedMaxCheckpointAt: false,
			checkpoints: [
				{
					paymentEventId: "ev-1111-2222-3333-4444",
					checkpointAt: "2026-09-15T10:00:00Z",
					periodMonth: currentMonth,
				},
			],
		};

		const decisionCenter: BudgetV2DecisionCenterView = {
			apiVersion: "budget-v2-product-api-v1",
			target: {
				paymentEventId: "ev-1111-2222-3333-4444",
				checkpointAt: "2026-09-15T10:00:00Z",
				periodMonth: currentMonth,
			},
			checkpoint: {
				temporalScope: "FROZEN_AT_CHECKPOINT",
				report: {
					availableToAllocateNow: {
						available: false,
						reason: "SURPLUS_USE_ATTRIBUTION_OVERLAP_UNRESOLVED",
						trueSurplus: "50000.00",
						candidateCount: 1,
						attributedCount: 0,
						unattributedSubjectIds: [],
						staleSubjectIds: [],
						overlapUnresolvedSubjectIds: ["sub-overlap"],
						knownAttributedCurrentSurplusUse: "0.00",
						unresolvedPotentialUseAmount: "500.00",
					},
				},
			},
		};

		vi.spyOn(dashboardApi, "fetchBudgetCheckpoints").mockResolvedValue(
			timeline,
		);
		vi.spyOn(dashboardApi, "fetchBudgetDecisionCenter").mockResolvedValue(
			decisionCenter,
		);

		renderWithQuery(<HeroAvailableSpend isUnlocked={true} />);

		expect(
			await screen.findByText("Kullanılabilir tutar henüz kesinleşmedi"),
		).toBeInTheDocument();
		expect(
			screen.queryByText("SURPLUS_USE_ATTRIBUTION_OVERLAP_UNRESOLVED"),
		).not.toBeInTheDocument();
		expect(screen.queryByText("₺50.000,00")).not.toBeInTheDocument();
	});

	it("fails closed when timeline has no checkpoints", async () => {
		const timeline: BudgetV2CheckpointTimeline = {
			apiVersion: "budget-v2-product-api-v1",
			limit: 50,
			sharedMaxCheckpointAt: false,
			checkpoints: [],
		};

		vi.spyOn(dashboardApi, "fetchBudgetCheckpoints").mockResolvedValue(
			timeline,
		);
		const decisionCenterSpy = vi.spyOn(
			dashboardApi,
			"fetchBudgetDecisionCenter",
		);

		renderWithQuery(<HeroAvailableSpend isUnlocked={true} />);

		expect(
			await screen.findByText(
				"Bu ay için doğrulanmış bütçe durumu henüz oluşmadı.",
			),
		).toBeInTheDocument();
		expect(decisionCenterSpy).not.toHaveBeenCalled();
		expect(screen.queryByText("₺0,00")).not.toBeInTheDocument();
	});

	it("fails closed when sharedMaxCheckpointAt is true (does not select row 0)", async () => {
		const timeline: BudgetV2CheckpointTimeline = {
			apiVersion: "budget-v2-product-api-v1",
			limit: 50,
			sharedMaxCheckpointAt: true,
			checkpoints: [
				{
					paymentEventId: "ev-ambiguous-1",
					checkpointAt: "2026-09-15T10:00:00Z",
					periodMonth: currentMonth,
				},
				{
					paymentEventId: "ev-ambiguous-2",
					checkpointAt: "2026-09-15T10:00:00Z",
					periodMonth: currentMonth,
				},
			],
		};

		vi.spyOn(dashboardApi, "fetchBudgetCheckpoints").mockResolvedValue(
			timeline,
		);
		const decisionCenterSpy = vi.spyOn(
			dashboardApi,
			"fetchBudgetDecisionCenter",
		);

		renderWithQuery(<HeroAvailableSpend isUnlocked={true} />);

		expect(
			await screen.findByText("En güncel bütçe durumu kesinleştirilemiyor."),
		).toBeInTheDocument();
		expect(decisionCenterSpy).not.toHaveBeenCalled();
		expect(screen.queryByText("₺0,00")).not.toBeInTheDocument();
	});

	it("fails closed when newest checkpoint is from an old month", async () => {
		const timeline: BudgetV2CheckpointTimeline = {
			apiVersion: "budget-v2-product-api-v1",
			limit: 50,
			sharedMaxCheckpointAt: false,
			checkpoints: [
				{
					paymentEventId: "ev-old-month",
					checkpointAt: "2026-08-31T10:00:00Z",
					periodMonth: "2026-08", // previous month
				},
			],
		};

		vi.spyOn(dashboardApi, "fetchBudgetCheckpoints").mockResolvedValue(
			timeline,
		);
		const decisionCenterSpy = vi.spyOn(
			dashboardApi,
			"fetchBudgetDecisionCenter",
		);

		renderWithQuery(<HeroAvailableSpend isUnlocked={true} />);

		expect(
			await screen.findByText(
				"Bu ay için doğrulanmış bütçe kontrol noktası henüz yok.",
			),
		).toBeInTheDocument();
		expect(decisionCenterSpy).not.toHaveBeenCalled();
	});

	it("fails closed when decision center target fails consistency check", async () => {
		const timeline: BudgetV2CheckpointTimeline = {
			apiVersion: "budget-v2-product-api-v1",
			limit: 50,
			sharedMaxCheckpointAt: false,
			checkpoints: [
				{
					paymentEventId: "ev-target-1",
					checkpointAt: "2026-09-15T10:00:00Z",
					periodMonth: currentMonth,
				},
			],
		};

		// Target mismatch in decision center response
		const decisionCenter: BudgetV2DecisionCenterView = {
			apiVersion: "budget-v2-product-api-v1",
			target: {
				paymentEventId: "ev-mismatched-id",
				checkpointAt: "2026-09-15T10:00:00Z",
				periodMonth: currentMonth,
			},
			checkpoint: {
				temporalScope: "FROZEN_AT_CHECKPOINT",
				report: {
					availableToAllocateNow: {
						available: true,
						amount: "14250.00",
						trueSurplus: "99999.00",
					},
				},
			},
		};

		vi.spyOn(dashboardApi, "fetchBudgetCheckpoints").mockResolvedValue(
			timeline,
		);
		vi.spyOn(dashboardApi, "fetchBudgetDecisionCenter").mockResolvedValue(
			decisionCenter,
		);

		renderWithQuery(<HeroAvailableSpend isUnlocked={true} />);

		expect(
			await screen.findByText("Bütçe durumu doğrulanamadı"),
		).toBeInTheDocument();
		expect(screen.queryByText("₺14.250,00")).not.toBeInTheDocument();
	});

	it("runtime extractor reads report.availableToAllocateNow (not report.mtd.availableToAllocateNow)", () => {
		const validDecisionCenter: BudgetV2DecisionCenterView = {
			apiVersion: "budget-v2-product-api-v1",
			target: {
				paymentEventId: "ev-1",
				checkpointAt: "2026-09-15T10:00:00Z",
				periodMonth: "2026-09",
			},
			checkpoint: {
				temporalScope: "FROZEN_AT_CHECKPOINT",
				report: {
					availableToAllocateNow: {
						available: true,
						amount: "5000.00",
						trueSurplus: "6000.00",
					},
				},
			},
		};

		const result = dashboardApi.extractAvailableToAllocateNow(
			validDecisionCenter,
			"ev-1",
			"2026-09",
		);
		expect(result.available).toBe(true);
		if (result.available) {
			expect(result.amount).toBe("5000.00");
		}

		// Obsolete report.mtd.availableToAllocateNow without top-level field must throw
		const obsoleteDecisionCenter: BudgetV2DecisionCenterView = {
			apiVersion: "budget-v2-product-api-v1",
			target: {
				paymentEventId: "ev-1",
				checkpointAt: "2026-09-15T10:00:00Z",
				periodMonth: "2026-09",
			},
			checkpoint: {
				temporalScope: "FROZEN_AT_CHECKPOINT",
				report: {
					mtd: {
						availableToAllocateNow: {
							available: true,
							amount: "5000.00",
						},
					},
				},
			},
		};

		expect(() =>
			dashboardApi.extractAvailableToAllocateNow(
				obsoleteDecisionCenter,
				"ev-1",
				"2026-09",
			),
		).toThrow();
	});
});

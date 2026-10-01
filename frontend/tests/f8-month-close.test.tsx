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
import { ApiError } from "../src/api/errors";
import * as monthCloseApi from "../src/api/month-close-api";
import type {
	MonthCloseProductDto,
	MonthCloseProposal,
} from "../src/api/month-close-types";
import * as quickEntryApi from "../src/api/quick-entry-api";
import { MonthCloseDetailPage } from "../src/components/month-close/MonthCloseDetailPage";
import { MonthCloseWizard } from "../src/components/month-close/MonthCloseWizard";

vi.mock("../src/api/month-close-api");
vi.mock("../src/api/quick-entry-api");

let mockParams: Record<string, string> = {};
let mockSearch: Record<string, any> = {};
const mockNavigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to, ...props }: any) => (
		<a href={to} {...props}>
			{children}
		</a>
	),
	useNavigate: () => mockNavigate,
	useParams: () => mockParams,
	useSearch: () => mockSearch,
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

const mockShortTermProposal: MonthCloseProposal = {
	periodMonth: "2026-08",
	budgetPlanId: "plan-1",
	budgetPlanRevisionNo: 1,
	policyVersion: "1.0",
	currency: "TRY",
	referenceIncome: "10000.00",
	mandatory: {
		ceiling: "5000.00",
		actualExpense: "4000.00",
		unused: "1000.00",
	},
	discretionary: {
		ceiling: "3000.00",
		actualExpense: "2500.00",
		unused: "500.00",
	},
	unclassifiedExpense: "0.00",
	closeSurplus: "1500.00",
	unappliedPriorAdjustments: "0.00",
	adjustedRoutableSurplus: "1500.00",
	midasAccountId: "midas-acc-1",
	midasUnallocatedBalance: "2000.00",
	route: "SHORT_TERM_GOAL",
	recommendedGoal: {
		goalId: "goal-laptop",
		revisionNo: 2,
		priority: 1,
		bucketId: "b-laptop",
		name: "Yeni Laptop",
		remainingToTarget: "3000.00",
	},
	fullOfferAmount: "1500.00",
	unroutedRemainderIfFull: "0.00",
	proposalFingerprint: "fp-abc-123",
	blockedReason: null,
};

const mockClosedHistoryItem: MonthCloseProductDto = {
	monthCloseId: "mc-1",
	userId: "u-1",
	periodMonth: "2026-07",
	budgetPlanId: "plan-1",
	budgetPlanRevisionNo: 1,
	policyVersion: "1.0",
	currency: "TRY",
	referenceIncome: "10000.00",
	mandatory: {
		ceiling: "5000.00",
		actualExpense: "4200.00",
		unused: "800.00",
	},
	discretionary: {
		ceiling: "3000.00",
		actualExpense: "2600.00",
		unused: "400.00",
	},
	unclassifiedExpense: "0.00",
	closeSurplus: "1200.00",
	unappliedPriorAdjustments: "0.00",
	adjustedRoutableSurplus: "1200.00",
	route: "SHORT_TERM_GOAL",
	decision: "PARTIAL",
	midasAccountId: "midas-acc-1",
	targetGoalId: "goal-laptop",
	targetGoalRevisionNo: 1,
	targetBucketId: "b-laptop",
	fullOfferAmount: "1200.00",
	appliedAmount: "800.00",
	unroutedAmount: "400.00",
	midasAllocationTransferId: "tx-1",
	proposalFingerprint: "fp-history-1",
	occurredAt: "2026-08-01T12:00:00.000Z",
	createdAt: "2026-08-01T12:00:00.000Z",
};

/** Helper to advance from Step 1 through to Step 4 */
async function advanceToStep4() {
	// Wait for Step 1 to be ready and enabled
	await waitFor(() => {
		expect(screen.getByTestId("wizard-step-1")).toBeDefined();
		const btn = screen.getByTestId("btn-wizard-next") as HTMLButtonElement;
		expect(btn.disabled).toBe(false);
	});
	fireEvent.click(screen.getByTestId("btn-wizard-next"));

	// Wait for Step 2 to be ready and enabled
	await waitFor(() => {
		expect(screen.getByTestId("wizard-step-2")).toBeDefined();
		const btn = screen.getByTestId("btn-wizard-next") as HTMLButtonElement;
		expect(btn.disabled).toBe(false);
	});
	fireEvent.click(screen.getByTestId("btn-wizard-next"));

	// Wait for Step 3 to be ready and enabled
	await waitFor(() => {
		expect(screen.getByTestId("wizard-step-3")).toBeDefined();
		const btn = screen.getByTestId("btn-wizard-next") as HTMLButtonElement;
		expect(btn.disabled).toBe(false);
	});
	fireEvent.click(screen.getByTestId("btn-wizard-next"));

	// Wait for Step 4
	await waitFor(() => {
		expect(screen.getByTestId("wizard-step-4")).toBeDefined();
	});
}

/** Helper to advance from Step 4 to Step 5 */
async function advanceToStep5() {
	await waitFor(() => {
		expect(screen.getByTestId("wizard-step-4")).toBeDefined();
		const btn = screen.getByTestId("btn-wizard-next") as HTMLButtonElement;
		expect(btn.disabled).toBe(false);
	});
	fireEvent.click(screen.getByTestId("btn-wizard-next"));
	await waitFor(() => {
		expect(screen.getByTestId("wizard-step-5")).toBeDefined();
	});
}

describe("F8 Month Close Tests", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockParams = {};
		mockSearch = {};
		vi.mocked(quickEntryApi.fetchAllActiveCreditCards).mockResolvedValue([]);
		vi.mocked(monthCloseApi.fetchMonthClose).mockResolvedValue(null);
	});

	afterEach(() => {
		cleanup();
	});

	// =========================================================================
	// Section 128: MONTH CLOSE CURRENT PERIOD (NOT ENDED)
	// =========================================================================
	describe("Section 128: Month Close Period Check", () => {
		it("shows warning and disables progression if period has not ended in Istanbul", async () => {
			const { wrapper } = createWrapper();
			// Far future period
			mockSearch = { periodMonth: "2099-12" };
			vi.mocked(monthCloseApi.fetchMonthClosePreview).mockResolvedValue({
				...mockShortTermProposal,
				periodMonth: "2099-12",
			});

			render(<MonthCloseWizard />, { wrapper });

			await waitFor(() => {
				expect(screen.getByText(/henüz tamamlanmadı/i)).toBeDefined();
			});

			const nextBtn = screen.getByTestId(
				"btn-wizard-next",
			) as HTMLButtonElement;
			expect(nextBtn.disabled).toBe(true);
		});
	});

	// =========================================================================
	// Section 129: UNCLASSIFIED EXPENSES BLOCKING (STEP 2)
	// =========================================================================
	describe("Section 129: Step 2 Unclassified Expenses Blocking", () => {
		it("displays aggregate unclassifiedExpense, blocks commit, and shows remediation actions", async () => {
			const { wrapper } = createWrapper();
			mockSearch = { periodMonth: "2026-08" };
			const unclassifiedProposal: MonthCloseProposal = {
				...mockShortTermProposal,
				route: "BLOCKED",
				blockedReason: "MONTH_CLOSE_UNCLASSIFIED_EXPENSES",
				unclassifiedExpense: "1850.75",
			};

			vi.mocked(monthCloseApi.fetchMonthClosePreview).mockResolvedValue(
				unclassifiedProposal,
			);

			render(<MonthCloseWizard />, { wrapper });

			// On Step 1, wait for ready
			await waitFor(() => {
				expect(screen.getByTestId("wizard-step-1")).toBeDefined();
				const btn = screen.getByTestId("btn-wizard-next") as HTMLButtonElement;
				expect(btn.disabled).toBe(false);
			});

			// Navigate to Step 2
			fireEvent.click(screen.getByTestId("btn-wizard-next"));

			// On Step 2, unclassifiedExpense amount and blocking alerts are displayed
			await waitFor(() => {
				expect(screen.getByTestId("wizard-step-2")).toBeDefined();
				const alert = screen.getByTestId("unclassified-block-alert");
				expect(alert.textContent).toContain("1.850,75");
				expect(alert.textContent).toContain(
					"sınıflandırılmamış harcamalar var",
				);
				expect(screen.getByTestId("btn-goto-transactions")).toBeDefined();
				expect(screen.getByTestId("btn-goto-cards")).toBeDefined();
				expect(screen.getByTestId("btn-recheck-preview")).toBeDefined();
			});

			// Next button must be disabled on Step 2 because of unclassified blocker
			const nextBtn = screen.getByTestId(
				"btn-wizard-next",
			) as HTMLButtonElement;
			expect(nextBtn.disabled).toBe(true);
		});
	});

	// =========================================================================
	// Section 130: STEP 3 IS INFORMATIONAL (CARD STATEMENT)
	// =========================================================================
	describe("Section 130: Step 3 Informational Card Check", () => {
		it("shows cards information but does not block progression", async () => {
			const { wrapper } = createWrapper();
			mockSearch = { periodMonth: "2026-08" };
			vi.mocked(monthCloseApi.fetchMonthClosePreview).mockResolvedValue(
				mockShortTermProposal,
			);
			vi.mocked(quickEntryApi.fetchAllActiveCreditCards).mockResolvedValue([
				{
					cardId: "card-1",
					userId: "u-1",
					code: "BONUS_KART",
					displayName: "Bonus Kart",
					issuer: "Garanti",
					status: "ACTIVE",
					revisionNo: 1,
					lastFour: "1234",
					creditLimit: "10000.00",
					statementDay: 15,
					dueDay: 25,
					note: null,
					liveLiabilityBalance: "1500.00",
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			]);

			render(<MonthCloseWizard />, { wrapper });

			// Step 1 -> 2
			await waitFor(() => {
				expect(screen.getByTestId("wizard-step-1")).toBeDefined();
				const btn = screen.getByTestId("btn-wizard-next") as HTMLButtonElement;
				expect(btn.disabled).toBe(false);
			});
			fireEvent.click(screen.getByTestId("btn-wizard-next"));

			// Step 2 -> 3
			await waitFor(() => {
				expect(screen.getByTestId("wizard-step-2")).toBeDefined();
				const btn = screen.getByTestId("btn-wizard-next") as HTMLButtonElement;
				expect(btn.disabled).toBe(false);
			});
			fireEvent.click(screen.getByTestId("btn-wizard-next"));

			// On Step 3, card info is shown
			await waitFor(() => {
				expect(screen.getByTestId("wizard-step-3")).toBeDefined();
				expect(screen.getByText(/Bonus Kart/i)).toBeDefined();
			});

			// Progression should NOT be disabled on Step 3
			const nextBtn = screen.getByTestId(
				"btn-wizard-next",
			) as HTMLButtonElement;
			expect(nextBtn.disabled).toBe(false);
		});
	});

	// =========================================================================
	// Section 131, 132, 133: SHORT_TERM_GOAL FULL, PARTIAL, SKIP
	// =========================================================================
	describe("Section 131-133: SHORT_TERM_GOAL Decisions", () => {
		it("FULL decision omits partialAmount and sends decision: FULL", async () => {
			const { wrapper } = createWrapper();
			mockSearch = { periodMonth: "2026-08" };
			vi.mocked(monthCloseApi.fetchMonthClosePreview).mockResolvedValue(
				mockShortTermProposal,
			);
			vi.mocked(monthCloseApi.commitMonthClose).mockResolvedValue({
				monthClose: {
					...mockClosedHistoryItem,
					decision: "FULL",
				},
			});

			render(<MonthCloseWizard />, { wrapper });

			await advanceToStep4();

			// Step 4: Choose FULL (default)
			expect(screen.getByTestId("decision-FULL")).toBeDefined();
			fireEvent.click(screen.getByTestId("decision-FULL"));

			await advanceToStep5();

			// Step 5: Commit
			expect(screen.getByTestId("btn-commit-month-close")).toBeDefined();
			fireEvent.click(screen.getByTestId("btn-commit-month-close"));

			await waitFor(() => {
				expect(monthCloseApi.commitMonthClose).toHaveBeenCalledWith(
					expect.objectContaining({
						periodMonth: "2026-08",
						expectedProposalFingerprint: "fp-abc-123",
						decision: "FULL",
					}),
					expect.any(String),
				);
				const callPayload = vi.mocked(monthCloseApi.commitMonthClose).mock
					.calls[0]?.[0];
				expect(callPayload).not.toHaveProperty("partialAmount");
			});
		});

		it("PARTIAL decision sends partialAmount and decision: PARTIAL", async () => {
			const { wrapper } = createWrapper();
			mockSearch = { periodMonth: "2026-08" };
			vi.mocked(monthCloseApi.fetchMonthClosePreview).mockResolvedValue(
				mockShortTermProposal,
			);
			vi.mocked(monthCloseApi.commitMonthClose).mockResolvedValue({
				monthClose: {
					...mockClosedHistoryItem,
					decision: "PARTIAL",
					appliedAmount: "500.00",
				},
			});

			render(<MonthCloseWizard />, { wrapper });

			await advanceToStep4();

			// Step 4: Choose PARTIAL
			fireEvent.click(screen.getByTestId("decision-PARTIAL"));

			// Enter partial amount: 500,00 (within 0 < x < 1500)
			await waitFor(() => {
				const input = document.getElementById(
					"partial-amount-input",
				) as HTMLInputElement;
				expect(input).toBeDefined();
			});
			const input = document.getElementById(
				"partial-amount-input",
			) as HTMLInputElement;
			fireEvent.change(input, { target: { value: "500,00" } });

			await advanceToStep5();

			// Step 5: Commit
			fireEvent.click(screen.getByTestId("btn-commit-month-close"));

			await waitFor(() => {
				expect(monthCloseApi.commitMonthClose).toHaveBeenCalledWith(
					expect.objectContaining({
						periodMonth: "2026-08",
						expectedProposalFingerprint: "fp-abc-123",
						decision: "PARTIAL",
						partialAmount: "500.00",
					}),
					expect.any(String),
				);
			});
		});

		it("SKIP decision omits partialAmount and sends decision: SKIP", async () => {
			const { wrapper } = createWrapper();
			mockSearch = { periodMonth: "2026-08" };
			vi.mocked(monthCloseApi.fetchMonthClosePreview).mockResolvedValue(
				mockShortTermProposal,
			);
			vi.mocked(monthCloseApi.commitMonthClose).mockResolvedValue({
				monthClose: {
					...mockClosedHistoryItem,
					decision: "SKIP",
				},
			});

			render(<MonthCloseWizard />, { wrapper });

			await advanceToStep4();

			// Step 4: Choose SKIP
			fireEvent.click(screen.getByTestId("decision-SKIP"));

			await advanceToStep5();

			fireEvent.click(screen.getByTestId("btn-commit-month-close"));

			await waitFor(() => {
				expect(monthCloseApi.commitMonthClose).toHaveBeenCalledWith(
					expect.objectContaining({
						periodMonth: "2026-08",
						expectedProposalFingerprint: "fp-abc-123",
						decision: "SKIP",
					}),
					expect.any(String),
				);
				const callPayload = vi.mocked(monthCloseApi.commitMonthClose).mock
					.calls[0]?.[0];
				expect(callPayload).not.toHaveProperty("partialAmount");
			});
		});
	});

	// =========================================================================
	// Section 134 & 135: MEDIUM_TERM_RESERVE & NONE ROUTE (NO DECISION SENT)
	// =========================================================================
	describe("Section 134 & 135: MEDIUM_TERM_RESERVE & NONE Route Authority", () => {
		it("omits decision and partialAmount for MEDIUM_TERM_RESERVE route", async () => {
			const { wrapper } = createWrapper();
			mockSearch = { periodMonth: "2026-08" };
			const mediumProposal: MonthCloseProposal = {
				...mockShortTermProposal,
				route: "MEDIUM_TERM_RESERVE",
				recommendedGoal: null,
			};
			vi.mocked(monthCloseApi.fetchMonthClosePreview).mockResolvedValue(
				mediumProposal,
			);
			vi.mocked(monthCloseApi.commitMonthClose).mockResolvedValue({
				monthClose: {
					...mockClosedHistoryItem,
					route: "MEDIUM_TERM_RESERVE",
					decision: "AUTO_MEDIUM",
				},
			});

			render(<MonthCloseWizard />, { wrapper });

			await advanceToStep4();
			await advanceToStep5();

			fireEvent.click(screen.getByTestId("btn-commit-month-close"));

			await waitFor(() => {
				expect(monthCloseApi.commitMonthClose).toHaveBeenCalledWith(
					expect.objectContaining({
						periodMonth: "2026-08",
						expectedProposalFingerprint: "fp-abc-123",
					}),
					expect.any(String),
				);
				const callPayload = vi.mocked(monthCloseApi.commitMonthClose).mock
					.calls[0]?.[0];
				expect(callPayload).not.toHaveProperty("decision");
				expect(callPayload).not.toHaveProperty("partialAmount");
			});
		});

		it("omits decision and partialAmount for NONE route", async () => {
			const { wrapper } = createWrapper();
			mockSearch = { periodMonth: "2026-08" };
			const noneProposal: MonthCloseProposal = {
				...mockShortTermProposal,
				route: "NONE",
				recommendedGoal: null,
			};
			vi.mocked(monthCloseApi.fetchMonthClosePreview).mockResolvedValue(
				noneProposal,
			);
			vi.mocked(monthCloseApi.commitMonthClose).mockResolvedValue({
				monthClose: {
					...mockClosedHistoryItem,
					route: "NONE",
					decision: "NO_ACTION",
				},
			});

			render(<MonthCloseWizard />, { wrapper });

			await advanceToStep4();
			await advanceToStep5();

			fireEvent.click(screen.getByTestId("btn-commit-month-close"));

			await waitFor(() => {
				const callPayload = vi.mocked(monthCloseApi.commitMonthClose).mock
					.calls[0]?.[0];
				expect(callPayload).not.toHaveProperty("decision");
				expect(callPayload).not.toHaveProperty("partialAmount");
			});
		});
	});

	// =========================================================================
	// Section 136: STALE FINGERPRINT OCC
	// =========================================================================
	describe("Section 136: Stale Proposal Fingerprint Handling", () => {
		it("refetches preview and returns to review on MONTH_CLOSE_STALE_PROPOSAL", async () => {
			const { wrapper } = createWrapper();
			mockSearch = { periodMonth: "2026-08" };
			vi.mocked(monthCloseApi.fetchMonthClosePreview).mockResolvedValue(
				mockShortTermProposal,
			);
			vi.mocked(monthCloseApi.commitMonthClose).mockRejectedValueOnce(
				new ApiError({
					status: 409,
					code: "MONTH_CLOSE_STALE_PROPOSAL",
					message: "Stale proposal",
				}),
			);

			render(<MonthCloseWizard />, { wrapper });

			await advanceToStep4();
			await advanceToStep5();

			fireEvent.click(screen.getByTestId("btn-commit-month-close"));

			await waitFor(() => {
				expect(
					screen.getByText(/Kapanış verileri siz incelerken değişti/i),
				).toBeDefined();
			});
		});
	});

	// =========================================================================
	// Section 139: CLOSED MONTH DETAIL
	// =========================================================================
	describe("Section 139: Closed Month Detail", () => {
		it("renders authoritative appliedAmount and unroutedAmount for completed close", async () => {
			const { wrapper } = createWrapper();
			mockParams = { periodMonth: "2026-07" };
			vi.mocked(monthCloseApi.fetchMonthClose).mockResolvedValue(
				mockClosedHistoryItem,
			);

			render(<MonthCloseDetailPage periodMonth="2026-07" />, { wrapper });

			await waitFor(() => {
				expect(screen.getByText(/Kapanış Özeti/i)).toBeDefined();
				expect(screen.getAllByText(/800,00/i).length).toBeGreaterThan(0);
				expect(screen.getAllByText(/400,00/i).length).toBeGreaterThan(0);
			});
		});
	});
});

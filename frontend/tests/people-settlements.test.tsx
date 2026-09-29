import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors";
import * as manualExpensesApi from "../src/api/manual-expenses-api";
import * as peopleApi from "../src/api/people-api";
import type {
	ObligationProductDto,
	PersonBalanceSummaryDto,
	PersonProductDto,
	SettlePersonReceivablesResult,
} from "../src/api/people-types";
import { PayableSettlementModal } from "../src/components/people/obligations/PayableSettlementModal";
import { PersonSettleReceivablesPage } from "../src/components/people/settlements/PersonSettleReceivablesPage";

vi.mock("../src/api/people-api");
vi.mock("../src/api/manual-expenses-api");

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}

async function renderWithRouter(ui: React.ReactElement) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});

	const rootRoute = createRootRoute({
		component: () => ui,
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/people/p1/settle"] }),
	});
	await router.load();

	return render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
}

describe("F6 Settlements — Root Orchestrator, Waterfall, Cash vs Midas & Payable Overpayment Guard", () => {
	const samplePerson: PersonProductDto = {
		personId: "p1",
		status: "ACTIVE",
		displayName: "Caner",
		relationship: "FRIEND",
		note: null,
		revisionNo: 1,
		receivableBalance: "420.00",
		payableBalance: "0.00",
	};

	const sampleSummary: PersonBalanceSummaryDto = {
		personId: "p1",
		displayName: "Caner",
		relationship: "FRIEND",
		exactReceivableBalance: "420.00",
		exactPayableBalance: "0.00",
		collectionTarget: "425.00",
	};

	beforeEach(() => {
		vi.clearAllMocks();

		vi.spyOn(peopleApi, "fetchPerson").mockResolvedValue({
			person: samplePerson,
		});
		vi.spyOn(peopleApi, "fetchPersonBalanceSummary").mockResolvedValue(
			sampleSummary,
		);

		vi.spyOn(manualExpensesApi, "fetchAllLedgerAccounts").mockResolvedValue([
			{
				accountId: "acc-bank",
				code: "102.01",
				name: "İş Bankası Vadesiz",
				accountType: "ASSET",
				normalBalance: "DEBIT",
				currency: "TRY",
				archived: false,
				balance: "8000.00",
			},
		]);

		vi.spyOn(peopleApi, "fetchMidasLiquidity").mockResolvedValue({
			liquidity: {
				midasAccountId: "m1",
				ledgerAccountId: "acc-midas-liq",
				currency: "TRY",
				physicalBalance: "5000.00",
				totalEarmarked: "0.00",
				unallocatedBalance: "5000.00",
				buckets: [],
			},
		});
	});

	it("executes root settlement with atomic single endpoint, rendering exact backend waterfall routing", async () => {
		const waterfallResult: SettlePersonReceivablesResult = {
			cashReceived: "500.00",
			receivableApplied: "420.00",
			excess: "80.00",
			remainingReceivable: "0.00",
			routing: [
				{
					destination: "CREDIT_CARD_RESERVE",
					amount: "50.00",
				},
				{
					destination: "SHORT_TERM_GOAL",
					amount: "20.00",
				},
				{
					destination: "LONG_TERM",
					amount: "10.00",
				},
			],
		};

		const mockSettle = vi
			.spyOn(peopleApi, "settlePersonReceivables")
			.mockResolvedValue(waterfallResult);

		await renderWithRouter(<PersonSettleReceivablesPage personId="p1" />);

		await waitFor(() => {
			expect(screen.getByTestId("method-midas-radio")).toBeInTheDocument();
		});

		// Switch to Midas receipt
		fireEvent.click(screen.getByTestId("method-midas-radio"));

		// Enter amount 500.00
		fireEvent.change(screen.getByTestId("money-input"), {
			target: { value: "500.00" },
		});

		// Submit
		fireEvent.click(screen.getByTestId("settle-submit-btn"));

		await waitFor(() => {
			expect(mockSettle).toHaveBeenCalledTimes(1);
		});

		// Assert call parameters: single atomic call, isCash=false, destination=acc-midas-liq
		const [personIdArg, payload, idempotencyKey] = mockSettle.mock.calls[0]!;
		expect(personIdArg).toBe("p1");
		expect(payload.cashAmount).toBe("500.00");
		expect(payload.isCash).toBe(false);
		expect(payload.destinationAssetAccountId).toBe("acc-midas-liq");
		expect(typeof idempotencyKey).toBe("string");

		// Assert Authoritative Waterfall result UI per Section 44 & 71
		await waitFor(() => {
			expect(
				screen.getByTestId("settle-receivables-success-view"),
			).toBeInTheDocument();
		});

		expect(screen.getByTestId("result-cash-received")).toHaveTextContent(
			"₺500,00",
		);
		expect(screen.getByTestId("result-receivable-applied")).toHaveTextContent(
			"₺420,00",
		);
		expect(screen.getByTestId("result-excess")).toHaveTextContent("₺80,00");

		// Exact Turkish destination labels
		expect(
			screen.getByTestId("routing-item-CREDIT_CARD_RESERVE"),
		).toHaveTextContent("Kart Rezervi");
		expect(
			screen.getByTestId("routing-item-CREDIT_CARD_RESERVE"),
		).toHaveTextContent("₺50,00");
		expect(
			screen.getByTestId("routing-item-SHORT_TERM_GOAL"),
		).toHaveTextContent("Kısa Vadeli Hedef");
		expect(
			screen.getByTestId("routing-item-SHORT_TERM_GOAL"),
		).toHaveTextContent("₺20,00");
		expect(screen.getByTestId("routing-item-LONG_TERM")).toHaveTextContent(
			"Uzun Vadeli",
		);
		expect(screen.getByTestId("routing-item-LONG_TERM")).toHaveTextContent(
			"₺10,00",
		);
	});

	it("shows cash-retained notice on cash overpayment and does not fabricate waterfall allocations", async () => {
		const cashResult: SettlePersonReceivablesResult = {
			cashReceived: "500.00",
			receivableApplied: "420.00",
			excess: "80.00",
			remainingReceivable: "0.00",
			routing: [], // No waterfall in cash mode
		};

		vi.spyOn(peopleApi, "settlePersonReceivables").mockResolvedValue(
			cashResult,
		);

		await renderWithRouter(<PersonSettleReceivablesPage personId="p1" />);

		await waitFor(() => {
			expect(screen.getByTestId("method-cash-radio")).toBeInTheDocument();
		});

		// Leave cash mode (isCash = true)
		fireEvent.change(screen.getByTestId("money-input"), {
			target: { value: "500.00" },
		});

		fireEvent.click(screen.getByTestId("settle-submit-btn"));

		await waitFor(() => {
			expect(screen.getByTestId("cash-retained-notice")).toBeInTheDocument();
		});

		// Assert natural copy per Section 40 & 72
		expect(screen.getByTestId("cash-retained-notice")).toHaveTextContent(
			"Fazla alınan tutar seçtiğiniz hesapta kaldı. Otomatik Kart Rezervi / hedef yönlendirmesi uygulanmadı.",
		);

		// Assert NO fake routing destinations are shown
		expect(screen.queryByText("Kart Rezervi")).not.toBeInTheDocument();
		expect(screen.queryByText("Kısa Vadeli Hedef")).not.toBeInTheDocument();
		expect(screen.queryByText("Uzun Vadeli")).not.toBeInTheDocument();
	});

	it("disables Midas option when liquidity account is not configured", async () => {
		vi.spyOn(peopleApi, "fetchMidasLiquidity").mockResolvedValue({
			liquidity: null,
		});

		await renderWithRouter(<PersonSettleReceivablesPage personId="p1" />);

		await waitFor(() => {
			expect(screen.getByTestId("midas-unavailable-hint")).toBeInTheDocument();
		});

		// Radio should be disabled
		expect(screen.getByTestId("method-midas-radio")).toBeDisabled();

		// Natural copy per Section 42
		expect(screen.getByTestId("midas-unavailable-hint")).toHaveTextContent(
			"Midas hesabına gelen ödeme için önce likidite hesabı yapılandırılmalı. Bu ayar F7 Likidite ekranında yönetilecek.",
		);
	});

	it("handles network uncertainty with identical idempotency key and payload on retry", async () => {
		const networkError = new ApiError({
			status: 0,
			code: "NETWORK_ERROR",
			message: "Failed to fetch",
		});

		const mockSettle = vi
			.spyOn(peopleApi, "settlePersonReceivables")
			.mockRejectedValueOnce(networkError)
			.mockResolvedValueOnce({
				cashReceived: "420.00",
				receivableApplied: "420.00",
				excess: "0.00",
				remainingReceivable: "0.00",
				routing: [],
			});

		await renderWithRouter(<PersonSettleReceivablesPage personId="p1" />);

		await waitFor(() => {
			expect(screen.getByTestId("settle-submit-btn")).toBeInTheDocument();
		});

		fireEvent.change(screen.getByTestId("money-input"), {
			target: { value: "420.00" },
		});

		// First attempt
		fireEvent.click(screen.getByTestId("settle-submit-btn"));

		await waitFor(() => {
			expect(screen.getByTestId("retry-settle-btn")).toBeInTheDocument();
		});

		// Natural copy per Section 47
		expect(screen.getByTestId("network-uncertain-box")).toBeInTheDocument();

		const firstCall = mockSettle.mock.calls[0]!;
		const firstKey = firstCall[2];
		const firstPayload = firstCall[1];

		// Retry attempt
		fireEvent.click(screen.getByTestId("retry-settle-btn"));

		await waitFor(() => {
			expect(mockSettle).toHaveBeenCalledTimes(2);
		});

		const secondCall = mockSettle.mock.calls[1]!;
		const secondKey = secondCall[2];
		const secondPayload = secondCall[1];

		// Key and payload must be identical
		expect(secondKey).toBe(firstKey);
		expect(secondPayload.cashAmount).toBe(firstPayload.cashAmount);
		expect(secondPayload.destinationAssetAccountId).toBe(
			firstPayload.destinationAssetAccountId,
		);
		expect(secondPayload.isCash).toBe(firstPayload.isCash);
		expect(secondPayload.occurredAt).toBe(firstPayload.occurredAt);
	});

	it("blocks payable settlement before POST when amount exceeds remainingAmount", async () => {
		const openPayable: ObligationProductDto = {
			obligationId: "ob-pay-1",
			personId: "p1",
			direction: "PAYABLE",
			status: "OPEN",
			principalAmount: "100.00",
			settledAmount: "0.00",
			remainingAmount: "100.00",
			dueDate: null,
			description: "Borç",
			budgetCategory: "MANDATORY_EXPENSE",
			revisionNo: 1,
			isSplitManaged: false,
		};

		const mockSettlePayable = vi.spyOn(peopleApi, "settlePersonPayable");

		render(
			<PayableSettlementModal
				isOpen={true}
				onClose={vi.fn()}
				personId="p1"
				obligation={openPayable}
			/>,
			{ wrapper: createWrapper() },
		);

		await waitFor(() => {
			expect(screen.getByTestId("payable-settlement-form")).toBeInTheDocument();
		});

		// Enter 101.00 (exceeds remaining 100.00)
		fireEvent.change(screen.getByTestId("money-input"), {
			target: { value: "101.00" },
		});

		fireEvent.click(screen.getByTestId("confirm-settle-payable-btn"));

		await waitFor(() => {
			expect(screen.getByTestId("settle-payable-error")).toBeInTheDocument();
		});

		// Verify error message and no POST was issued
		expect(screen.getByTestId("settle-payable-error")).toHaveTextContent(
			"Ödeme tutarı kalan borç tutarından (₺100,00) fazla olamaz.",
		);
		expect(mockSettlePayable).not.toHaveBeenCalled();

		// Now enter valid 100.00
		mockSettlePayable.mockResolvedValueOnce({
			settlement: {
				settlementId: "set-p1",
				obligationId: "ob-pay-1",
				personId: "p1",
				direction: "PAYABLE",
				status: "ACTIVE",
				cashAmount: "100.00",
				appliedAmount: "100.00",
				excessAmount: "0.00",
				note: null,
				occurredAt: "2026-03-29T10:00:00Z",
				revisionNo: 1,
			},
		});

		fireEvent.change(screen.getByTestId("money-input"), {
			target: { value: "100.00" },
		});

		fireEvent.click(screen.getByTestId("confirm-settle-payable-btn"));

		await waitFor(() => {
			expect(mockSettlePayable).toHaveBeenCalledTimes(1);
		});

		const [, , payablePayload, idempotencyKey] =
			mockSettlePayable.mock.calls[0]!;
		expect(payablePayload.amount).toBe("100.00");
		expect(typeof idempotencyKey).toBe("string");
	});

	it("R2: payable settlement uncertain retry uses exact same Idempotency-Key, payload, and occurredAt", async () => {
		const openPayable: ObligationProductDto = {
			obligationId: "ob-pay-unc",
			personId: "p1",
			direction: "PAYABLE",
			status: "OPEN",
			principalAmount: "500.00",
			settledAmount: "100.00",
			remainingAmount: "400.00",
			dueDate: null,
			description: "Payable test",
			budgetCategory: "MANDATORY_EXPENSE",
			revisionNo: 3,
			isSplitManaged: false,
		};

		const networkError = new ApiError({
			status: 0,
			code: "NETWORK_ERROR",
			message: "Network dropped",
		});

		const mockSettlePayable = vi
			.spyOn(peopleApi, "settlePersonPayable")
			.mockRejectedValueOnce(networkError)
			.mockResolvedValueOnce({
				settlement: {
					settlementId: "set-p-unc",
					obligationId: "ob-pay-unc",
					personId: "p1",
					direction: "PAYABLE",
					status: "ACTIVE",
					cashAmount: "200.00",
					appliedAmount: "200.00",
					excessAmount: "0.00",
					note: "Taksit",
					occurredAt: "2026-03-29T12:00:00Z",
					revisionNo: 1,
				},
			});

		render(
			<PayableSettlementModal
				isOpen={true}
				onClose={vi.fn()}
				personId="p1"
				obligation={openPayable}
			/>,
			{ wrapper: createWrapper() },
		);

		await waitFor(() => {
			expect(screen.getByTestId("payable-settlement-form")).toBeInTheDocument();
		});

		fireEvent.change(screen.getByTestId("money-input"), {
			target: { value: "200.00" },
		});
		fireEvent.change(screen.getByTestId("payable-note-input"), {
			target: { value: "Taksit" },
		});

		fireEvent.click(screen.getByTestId("confirm-settle-payable-btn"));

		await waitFor(() => {
			expect(mockSettlePayable).toHaveBeenCalledTimes(1);
		});

		expect(
			await screen.findByTestId("settle-payable-uncertain-alert"),
		).toBeInTheDocument();
		expect(
			screen.getByText("Ödemenin kaydedilip kaydedilmediği doğrulanamadı."),
		).toBeInTheDocument();

		fireEvent.click(screen.getByTestId("retry-uncertain-btn"));

		await waitFor(() => {
			expect(mockSettlePayable).toHaveBeenCalledTimes(2);
		});

		const [, , call1Payload, call1Key] = mockSettlePayable.mock.calls[0]!;
		const [, , call2Payload, call2Key] = mockSettlePayable.mock.calls[1]!;

		expect(call2Key).toBe(call1Key);
		expect(call2Payload).toEqual(call1Payload);
		expect(call2Payload.amount).toBe("200.00");
		expect(call2Payload.note).toBe("Taksit");
		expect(call2Payload.sourceAssetAccountId).toBe(
			call1Payload.sourceAssetAccountId,
		);
		expect(call2Payload.occurredAt).toBe(call1Payload.occurredAt);
	});
});

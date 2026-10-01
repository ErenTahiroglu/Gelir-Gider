import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as creditCardsApi from "../src/api/credit-cards-api";
import * as manualExpensesApi from "../src/api/manual-expenses-api";
import { StatementForm } from "../src/components/cards/statements/StatementForm";
import { StatementPayModal } from "../src/components/cards/statements/StatementPayModal";
import { StatementReopenModal } from "../src/components/cards/statements/StatementReopenModal";

vi.mock("../src/api/credit-cards-api");
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

describe("F5 Card Statements & Payment Lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("disables statement creation and shows natural notice when no Midas account is configured", async () => {
		vi.spyOn(creditCardsApi, "fetchMidasLiquidity").mockResolvedValue({
			liquidity: null,
		});

		render(<StatementForm mode="create" cardId="card-1" />, {
			wrapper: createWrapper(),
		});

		await waitFor(() => {
			expect(
				screen.getByText(
					/Ekstre oluşturmak için önce Midas likidite hesabı yapılandırılmalı/i,
				),
			).toBeInTheDocument();
		});

		expect(
			screen.getByRole("button", { name: /Ekstreyi Oluştur/i }),
		).toBeDisabled();
	});

	it("renders liabilityCoverage and reserveSatisfied distinctly without conflating them", async () => {
		const statement: creditCardsApi.CreditCardStatementItem = {
			statementId: "stmt-1",
			cardId: "card-1",
			cycleYear: 2026,
			cycleMonth: 3,
			status: "OPEN",
			revisionNo: 1,
			statementAmount: "5000.00",
			statementDate: "2026-03-15",
			dueDate: "2026-03-25",
			reservePlacement: "MIDAS_FUND",
			reserveAmount: "5000.00",
			reserveSatisfied: false, // Reserve NOT satisfied!
			note: null,
		};

		vi.spyOn(creditCardsApi, "fetchStatementReadiness").mockResolvedValue({
			readiness: {
				statementId: "stmt-1",
				cardId: "card-1",
				statementAmount: "5000.00",
				cardLiabilityBalance: "6000.00",
				reservePlacement: "MIDAS_FUND",
				reserveAmount: "5000.00",
				liabilityCoverage: "READY", // Liability is READY
				liabilityAfterPayment: "1000.00",
			},
		});

		render(
			<StatementPayModal
				cardId="card-1"
				statement={statement}
				isOpen={true}
				onClose={vi.fn()}
				onSuccess={vi.fn()}
			/>,
			{ wrapper: createWrapper() },
		);

		await waitFor(() => {
			expect(screen.getByTestId("liability-coverage-status")).toHaveTextContent(
				"Hazır",
			);
		});

		// Must NOT claim Midas reserve is ready!
		expect(screen.getByTestId("reserve-satisfied-status")).toHaveTextContent(
			"Eksik",
		);

		// R2: Pay button MUST be disabled when MIDAS_FUND reserve is unsatisfied
		expect(screen.getByTestId("confirm-statement-pay-button")).toBeDisabled();
		expect(screen.getByTestId("reserve-shortfall-warning")).toHaveTextContent(
			"Kart Rezervi tutarı ekstre için eksik kalmaktadır.",
		);

		// Attempted submit must not call payCreditCardStatement
		const mockPay = vi.spyOn(creditCardsApi, "payCreditCardStatement");
		fireEvent.click(screen.getByTestId("confirm-statement-pay-button"));
		expect(mockPay).not.toHaveBeenCalled();
	});

	it("fails closed when readiness query errors, presents natural unavailable copy and allows retry (R1)", async () => {
		const statement: creditCardsApi.CreditCardStatementItem = {
			statementId: "stmt-1",
			cardId: "card-1",
			cycleYear: 2026,
			cycleMonth: 3,
			status: "OPEN",
			revisionNo: 1,
			statementAmount: "3000.00",
			statementDate: "2026-03-15",
			dueDate: "2026-03-25",
			reservePlacement: "MIDAS_FUND",
			reserveAmount: "3000.00",
			reserveSatisfied: true,
			note: null,
		};

		const mockPay = vi.spyOn(creditCardsApi, "payCreditCardStatement");
		const readinessSpy = vi
			.spyOn(creditCardsApi, "fetchStatementReadiness")
			.mockRejectedValueOnce(new Error("API network failure"))
			.mockResolvedValueOnce({
				readiness: {
					statementId: "stmt-1",
					cardId: "card-1",
					statementAmount: "3000.00",
					cardLiabilityBalance: "4000.00",
					reservePlacement: "MIDAS_FUND",
					reserveAmount: "3000.00",
					liabilityCoverage: "READY",
					liabilityAfterPayment: "1000.00",
				},
			});

		render(
			<StatementPayModal
				cardId="card-1"
				statement={statement}
				isOpen={true}
				onClose={vi.fn()}
				onSuccess={vi.fn()}
			/>,
			{ wrapper: createWrapper() },
		);

		// Must show unavailable state and retry button
		await waitFor(() => {
			expect(
				screen.getByTestId("readiness-unavailable-state"),
			).toBeInTheDocument();
		});

		expect(screen.getByTestId("readiness-error-message")).toHaveTextContent(
			"Ödeme hazırlık durumu alınamadı.",
		);
		// Must not falsely claim Yetersiz or Hazır for liabilityCoverage
		expect(
			screen.queryByTestId("liability-coverage-status"),
		).not.toBeInTheDocument();

		// Pay button must remain disabled
		const payBtn = screen.getByTestId("confirm-statement-pay-button");
		expect(payBtn).toBeDisabled();

		// Submit must not issue financial POST
		fireEvent.click(payBtn);
		expect(mockPay).not.toHaveBeenCalled();

		// Click retry readiness button
		fireEvent.click(screen.getByTestId("retry-readiness-button"));

		// Readiness recovers to READY
		await waitFor(() => {
			expect(screen.getByTestId("liability-coverage-status")).toHaveTextContent(
				"Hazır",
			);
		});

		// Now payment is eligible
		expect(readinessSpy).toHaveBeenCalledTimes(2);
		expect(
			screen.getByTestId("confirm-statement-pay-button"),
		).not.toBeDisabled();
	});

	it("fails closed when readiness payload is missing or undefined (R1)", async () => {
		const statement: creditCardsApi.CreditCardStatementItem = {
			statementId: "stmt-1",
			cardId: "card-1",
			cycleYear: 2026,
			cycleMonth: 3,
			status: "OPEN",
			revisionNo: 1,
			statementAmount: "2500.00",
			statementDate: "2026-03-15",
			dueDate: "2026-03-25",
			reservePlacement: "MIDAS_FUND",
			reserveAmount: "2500.00",
			reserveSatisfied: true,
			note: null,
		};

		const mockPay = vi.spyOn(creditCardsApi, "payCreditCardStatement");
		vi.spyOn(creditCardsApi, "fetchStatementReadiness").mockResolvedValue({
			readiness: null as any,
		});

		render(
			<StatementPayModal
				cardId="card-1"
				statement={statement}
				isOpen={true}
				onClose={vi.fn()}
				onSuccess={vi.fn()}
			/>,
			{ wrapper: createWrapper() },
		);

		await waitFor(() => {
			expect(
				screen.getByTestId("readiness-unavailable-state"),
			).toBeInTheDocument();
		});

		expect(screen.getByTestId("confirm-statement-pay-button")).toBeDisabled();
		fireEvent.click(screen.getByTestId("confirm-statement-pay-button"));
		expect(mockPay).not.toHaveBeenCalled();
	});

	it("blocks payment when liabilityCoverage is SHORTFALL", async () => {
		const statement: creditCardsApi.CreditCardStatementItem = {
			statementId: "stmt-1",
			cardId: "card-1",
			cycleYear: 2026,
			cycleMonth: 3,
			status: "OPEN",
			revisionNo: 1,
			statementAmount: "5000.00",
			statementDate: "2026-03-15",
			dueDate: "2026-03-25",
			reservePlacement: "OUTSIDE_MIDAS",
			reserveAmount: "0.00",
			reserveSatisfied: true,
			note: null,
		};

		vi.spyOn(creditCardsApi, "fetchStatementReadiness").mockResolvedValue({
			readiness: {
				statementId: "stmt-1",
				cardId: "card-1",
				statementAmount: "5000.00",
				cardLiabilityBalance: "2000.00",
				reservePlacement: "OUTSIDE_MIDAS",
				reserveAmount: "0.00",
				liabilityCoverage: "SHORTFALL",
				liabilityAfterPayment: "-3000.00",
			},
		});

		vi.spyOn(creditCardsApi, "fetchMidasLiquidity").mockResolvedValue({
			liquidity: null,
		});

		vi.spyOn(manualExpensesApi, "fetchAllLedgerAccounts").mockResolvedValue([]);

		render(
			<StatementPayModal
				cardId="card-1"
				statement={statement}
				isOpen={true}
				onClose={vi.fn()}
				onSuccess={vi.fn()}
			/>,
			{ wrapper: createWrapper() },
		);

		await waitFor(() => {
			expect(screen.getByTestId("liability-coverage-status")).toHaveTextContent(
				"Yetersiz",
			);
			expect(
				screen.getByText(/Kart yükümlülüğü ekstre tutarını karşılamıyor/i),
			).toBeInTheDocument();
		});

		expect(screen.getByTestId("confirm-statement-pay-button")).toBeDisabled();
	});

	it("performs one-tap payment for MIDAS_FUND without requiring asset selection", async () => {
		const statement: creditCardsApi.CreditCardStatementItem = {
			statementId: "stmt-1",
			cardId: "card-1",
			cycleYear: 2026,
			cycleMonth: 3,
			status: "OPEN",
			revisionNo: 2,
			statementAmount: "3000.00",
			statementDate: "2026-03-15",
			dueDate: "2026-03-25",
			reservePlacement: "MIDAS_FUND",
			reserveAmount: "3000.00",
			reserveSatisfied: true,
			note: null,
		};

		vi.spyOn(creditCardsApi, "fetchStatementReadiness").mockResolvedValue({
			readiness: {
				statementId: "stmt-1",
				cardId: "card-1",
				statementAmount: "3000.00",
				cardLiabilityBalance: "3000.00",
				reservePlacement: "MIDAS_FUND",
				reserveAmount: "3000.00",
				liabilityCoverage: "READY",
				liabilityAfterPayment: "0.00",
			},
		});

		const mockPay = vi
			.spyOn(creditCardsApi, "payCreditCardStatement")
			.mockResolvedValue({
				statement: { ...statement, status: "PAID" },
			});

		const onSuccess = vi.fn();
		render(
			<StatementPayModal
				cardId="card-1"
				statement={statement}
				isOpen={true}
				onClose={vi.fn()}
				onSuccess={onSuccess}
			/>,
			{ wrapper: createWrapper() },
		);

		await waitFor(() => {
			expect(
				screen.getByTestId("confirm-statement-pay-button"),
			).not.toBeDisabled();
		});

		// Outside asset select should NOT exist
		expect(
			screen.queryByLabelText(/Ödeme Kaynağı Hesap/i),
		).not.toBeInTheDocument();

		fireEvent.click(screen.getByTestId("confirm-statement-pay-button"));

		await waitFor(() => {
			expect(mockPay).toHaveBeenCalledTimes(1);
		});

		const [cId, sId, payload, key] = mockPay.mock.calls[0]!;
		expect(cId).toBe("card-1");
		expect(sId).toBe("stmt-1");
		expect(payload.expectedRevisionNo).toBe(2);
		expect(payload.outsidePaymentAssetAccountId).toBeUndefined();
		expect(typeof key).toBe("string");
	});

	it("requires non-Midas ASSET account for OUTSIDE_MIDAS payment and retains same key on retry", async () => {
		const statement: creditCardsApi.CreditCardStatementItem = {
			statementId: "stmt-outside",
			cardId: "card-1",
			cycleYear: 2026,
			cycleMonth: 3,
			status: "OPEN",
			revisionNo: 1,
			statementAmount: "1200.00",
			statementDate: "2026-03-15",
			dueDate: "2026-03-25",
			reservePlacement: "OUTSIDE_MIDAS",
			reserveAmount: "0.00",
			reserveSatisfied: true,
			note: null,
		};

		vi.spyOn(creditCardsApi, "fetchStatementReadiness").mockResolvedValue({
			readiness: {
				statementId: "stmt-outside",
				cardId: "card-1",
				statementAmount: "1200.00",
				cardLiabilityBalance: "2000.00",
				reservePlacement: "OUTSIDE_MIDAS",
				reserveAmount: "0.00",
				liabilityCoverage: "READY",
				liabilityAfterPayment: "800.00",
			},
		});

		vi.spyOn(creditCardsApi, "fetchMidasLiquidity").mockResolvedValue({
			liquidity: {
				midasAccountId: "midas-1",
				ledgerAccountId: "asset-midas", // Excluded from outside assets!
				currency: "TRY",
				physicalBalance: "10000.00",
				totalEarmarked: "0.00",
				unallocatedBalance: "10000.00",
				buckets: [],
			},
		});

		vi.spyOn(manualExpensesApi, "fetchAllLedgerAccounts").mockResolvedValue([
			{
				accountId: "asset-bank",
				code: "102.01",
				name: "Vakıfbank Vadesiz",
				accountType: "ASSET",
				normalBalance: "DEBIT",
				currency: "TRY",
				balance: "10000.00",
				archived: false,
			},
		]);

		const mockPay = vi
			.spyOn(creditCardsApi, "payCreditCardStatement")
			.mockRejectedValueOnce(new TypeError("Failed to fetch")) // Uncertain network failure!
			.mockResolvedValueOnce({
				statement: { ...statement, status: "PAID" },
			});

		render(
			<StatementPayModal
				cardId="card-1"
				statement={statement}
				isOpen={true}
				onClose={vi.fn()}
				onSuccess={vi.fn()}
			/>,
			{ wrapper: createWrapper() },
		);

		await waitFor(() => {
			expect(screen.getByLabelText(/Ödeme Kaynağı Hesap/i)).toBeInTheDocument();
		});

		fireEvent.change(screen.getByLabelText(/Ödeme Kaynağı Hesap/i), {
			target: { value: "asset-bank" },
		});

		fireEvent.click(screen.getByTestId("confirm-statement-pay-button"));

		// Network failure -> shows retry button with explanation
		await waitFor(() => {
			expect(
				screen.getByText(/Ödemenin tamamlanıp tamamlanmadığı doğrulanamadı/i),
			).toBeInTheDocument();
		});

		const retryBtn = screen.getByRole("button", { name: /Tekrar Dene/i });
		expect(retryBtn).toBeInTheDocument();

		// Retry payment
		fireEvent.click(retryBtn);

		await waitFor(() => {
			expect(mockPay).toHaveBeenCalledTimes(2);
		});

		// Both calls must have the EXACT SAME Idempotency-Key!
		const firstKey = mockPay.mock.calls[0]?.[3];
		const secondKey = mockPay.mock.calls[1]?.[3];
		expect(firstKey).toBe(secondKey);
		expect(mockPay.mock.calls[1]?.[2]).toEqual(mockPay.mock.calls[0]?.[2]);
	});

	it("reopens a paid statement with reversal lifecycle and natural copy", async () => {
		const paidStatement: creditCardsApi.CreditCardStatementItem = {
			statementId: "stmt-paid",
			cardId: "card-1",
			cycleYear: 2026,
			cycleMonth: 3,
			status: "PAID",
			revisionNo: 3,
			statementAmount: "4500.00",
			statementDate: "2026-03-15",
			dueDate: "2026-03-25",
			reservePlacement: "MIDAS_FUND",
			reserveAmount: "4500.00",
			reserveSatisfied: true,
			note: null,
		};

		const mockReopen = vi
			.spyOn(creditCardsApi, "reopenCreditCardStatement")
			.mockResolvedValue({
				statement: { ...paidStatement, status: "OPEN" },
			});

		const onSuccess = vi.fn();
		render(
			<StatementReopenModal
				cardId="card-1"
				statement={paidStatement}
				isOpen={true}
				onClose={vi.fn()}
				onSuccess={onSuccess}
			/>,
			{ wrapper: createWrapper() },
		);

		expect(
			screen.getByText(
				/Bu işlem önceki ödeme kaydının muhasebe etkisini tersine çevirir ve ekstreyi yeniden açık duruma getirir/i,
			),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /Ödemeyi Geri Aç/i }));

		await waitFor(() => {
			expect(mockReopen).toHaveBeenCalledTimes(1);
		});

		const [cId, sId, payload, key] = mockReopen.mock.calls[0]!;
		expect(cId).toBe("card-1");
		expect(sId).toBe("stmt-paid");
		expect(payload.expectedRevisionNo).toBe(3);
		expect(typeof key).toBe("string");
	});
});

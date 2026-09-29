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
import type { ObligationProductDto } from "../src/api/people-types";
import { ObligationDetailPage } from "../src/components/people/obligations/ObligationDetailPage";
import { ObligationForm } from "../src/components/people/obligations/ObligationForm";

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
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	await router.load();

	return render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
}

describe("F6 Obligations — Standalone Receivable/Payable, Split-Managed Guard, Void & Pagination", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Mock eligible ledger accounts
		vi.spyOn(manualExpensesApi, "fetchAllLedgerAccounts").mockResolvedValue([
			{
				accountId: "acc-bank",
				code: "102.01",
				name: "Vakıfbank Vadesiz",
				accountType: "ASSET",
				normalBalance: "DEBIT",
				currency: "TRY",
				archived: false,
				balance: "10000.00",
			},
			{
				accountId: "acc-cash",
				code: "100.01",
				name: "Nakit Cüzdan",
				accountType: "ASSET",
				normalBalance: "DEBIT",
				currency: "TRY",
				archived: false,
				balance: "2500.00",
			},
		]);
	});

	it("creates a standalone RECEIVABLE with fundingAssetAccountId selector and stable idempotency", async () => {
		const mockCreateReceivable = vi
			.spyOn(peopleApi, "createPersonReceivable")
			.mockResolvedValue({
				obligation: {
					obligationId: "ob-1",
					personId: "p1",
					direction: "RECEIVABLE",
					status: "OPEN",
					principalAmount: "350.00",
					settledAmount: "0.00",
					remainingAmount: "350.00",
					dueDate: "2026-04-15",
					description: "Ödünç para",
					budgetCategory: null,
					revisionNo: 1,
					isSplitManaged: false,
					fundingAssetAccountId: "acc-bank",
				},
			});

		const onSuccess = vi.fn();
		render(
			<ObligationForm
				mode="create"
				personId="p1"
				initialDirection="RECEIVABLE"
				onSuccess={onSuccess}
			/>,
			{ wrapper: createWrapper() },
		);

		await waitFor(() => {
			expect(
				screen.getByTestId("obligation-funding-account-select"),
			).toBeInTheDocument();
		});

		// Fill amount
		fireEvent.change(screen.getByLabelText(/Tutar/i), {
			target: { value: "350.00" },
		});

		// Choose funding asset account
		fireEvent.change(screen.getByTestId("obligation-funding-account-select"), {
			target: { value: "acc-bank" },
		});

		// Fill description and due date
		fireEvent.change(screen.getByLabelText(/Açıklama/i), {
			target: { value: "Ödünç para" },
		});
		fireEvent.change(screen.getByLabelText(/Vade Tarihi/i), {
			target: { value: "2026-04-15" },
		});

		fireEvent.click(screen.getByTestId("obligation-submit-btn"));

		await waitFor(() => {
			expect(mockCreateReceivable).toHaveBeenCalledTimes(1);
		});

		const [personIdArg, payload, idempotencyKey] =
			mockCreateReceivable.mock.calls[0]!;
		expect(personIdArg).toBe("p1");
		expect(payload.amount).toBe("350.00");
		expect(payload.fundingAssetAccountId).toBe("acc-bank");
		expect(payload.description).toBe("Ödünç para");
		expect(payload.dueDate).toBe("2026-04-15");
		expect(typeof idempotencyKey).toBe("string");
		expect(idempotencyKey!.length).toBeGreaterThan(10);
	});

	it("creates a standalone PAYABLE with financial classification and no funding asset", async () => {
		const mockCreatePayable = vi
			.spyOn(peopleApi, "createPersonPayable")
			.mockResolvedValue({
				obligation: {
					obligationId: "ob-2",
					personId: "p1",
					direction: "PAYABLE",
					status: "OPEN",
					principalAmount: "450.00",
					settledAmount: "0.00",
					remainingAmount: "450.00",
					dueDate: null,
					description: "Yemek borcu",
					budgetCategory: "MANDATORY_EXPENSE",
					revisionNo: 1,
					isSplitManaged: false,
				},
			});

		const onSuccess = vi.fn();
		render(
			<ObligationForm
				mode="create"
				personId="p1"
				initialDirection="PAYABLE"
				onSuccess={onSuccess}
			/>,
			{ wrapper: createWrapper() },
		);

		// Assert funding asset account is NOT displayed for payable
		expect(
			screen.queryByTestId("obligation-funding-account-select"),
		).not.toBeInTheDocument();

		// Classification options should be visible
		expect(screen.getByTestId("budget-mandatory")).toBeInTheDocument();
		expect(screen.getByTestId("budget-discretionary")).toBeInTheDocument();
		expect(screen.getByTestId("budget-short-term")).toBeInTheDocument();

		// Fill amount and select classification
		fireEvent.change(screen.getByLabelText(/Tutar/i), {
			target: { value: "450.00" },
		});
		fireEvent.click(screen.getByTestId("budget-mandatory"));
		fireEvent.change(screen.getByLabelText(/Açıklama/i), {
			target: { value: "Yemek borcu" },
		});

		fireEvent.click(screen.getByTestId("obligation-submit-btn"));

		await waitFor(() => {
			expect(mockCreatePayable).toHaveBeenCalledTimes(1);
		});

		const [personIdArg, payload, idempotencyKey] =
			mockCreatePayable.mock.calls[0]!;
		expect(personIdArg).toBe("p1");
		expect(payload.amount).toBe("450.00");
		expect(payload.budgetCategory).toBe("MANDATORY_EXPENSE");
		expect(payload.description).toBe("Yemek borcu");
		expect(typeof idempotencyKey).toBe("string");
	});

	it("guards split-managed obligations as read-only with badge and notice", async () => {
		const splitObligation: ObligationProductDto = {
			obligationId: "ob-split",
			personId: "p1",
			direction: "RECEIVABLE",
			status: "OPEN",
			principalAmount: "600.00",
			settledAmount: "0.00",
			remainingAmount: "600.00",
			dueDate: null,
			description: "Restoran bölüşümü",
			budgetCategory: null,
			revisionNo: 1,
			isSplitManaged: true, // Split managed from card
		};

		vi.spyOn(peopleApi, "fetchPersonObligation").mockResolvedValue({
			obligation: splitObligation,
		});
		vi.spyOn(peopleApi, "fetchObligationSettlements").mockResolvedValue({
			settlements: [],
			limit: 50,
			hasMore: false,
			nextCursor: null,
		});

		await renderWithRouter(
			<ObligationDetailPage personId="p1" obligationId="ob-split" />,
		);

		await waitFor(() => {
			expect(screen.getByTestId("split-managed-banner")).toBeInTheDocument();
		});

		// Assert badge text and explanatory notice
		expect(screen.getByTestId("split-managed-banner")).toHaveTextContent(
			"Kart bölüşümünden",
		);
		expect(screen.getByTestId("split-managed-banner")).toHaveTextContent(
			"Bu alacak kart harcaması bölüşümünden oluşturuldu. Tutarı değiştirmek için ilgili ortak harcamayı düzenleyin.",
		);

		// Assert edit and void buttons are HIDDEN
		expect(screen.queryByTestId("edit-obligation-btn")).not.toBeInTheDocument();
		expect(screen.queryByTestId("void-obligation-btn")).not.toBeInTheDocument();
	});

	it("voids standalone obligation using fresh OCC and stable idempotency", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);

		const standaloneObligation: ObligationProductDto = {
			obligationId: "ob-voidable",
			personId: "p1",
			direction: "RECEIVABLE",
			status: "OPEN",
			principalAmount: "200.00",
			settledAmount: "0.00",
			remainingAmount: "200.00",
			dueDate: null,
			description: "Borç kaydı",
			budgetCategory: null,
			revisionNo: 3,
			isSplitManaged: false,
		};

		vi.spyOn(peopleApi, "fetchPersonObligation").mockResolvedValue({
			obligation: standaloneObligation,
		});
		vi.spyOn(peopleApi, "fetchObligationSettlements").mockResolvedValue({
			settlements: [],
			limit: 50,
			hasMore: false,
			nextCursor: null,
		});

		const mockVoid = vi
			.spyOn(peopleApi, "voidPersonObligation")
			.mockResolvedValue({
				obligation: { ...standaloneObligation, status: "VOID", revisionNo: 4 },
			});

		await renderWithRouter(
			<ObligationDetailPage personId="p1" obligationId="ob-voidable" />,
		);

		await waitFor(() => {
			expect(screen.getByTestId("void-obligation-btn")).toBeInTheDocument();
		});

		fireEvent.click(screen.getByTestId("void-obligation-btn"));

		await waitFor(() => {
			expect(mockVoid).toHaveBeenCalledTimes(1);
		});

		expect(mockVoid).toHaveBeenCalledWith(
			"p1",
			"ob-voidable",
			{ expectedRevisionNo: 3 },
			expect.any(String),
		);
	});

	it("shows natural copy on PEOPLE_OBLIGATION_SETTLEMENT_CONFLICT when voiding", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);

		const obligationWithSettlement: ObligationProductDto = {
			obligationId: "ob-conflict",
			personId: "p1",
			direction: "PAYABLE",
			status: "OPEN",
			principalAmount: "500.00",
			settledAmount: "100.00",
			remainingAmount: "400.00",
			dueDate: null,
			description: "Kısmen ödenmiş borç",
			budgetCategory: "MANDATORY_EXPENSE",
			revisionNo: 2,
			isSplitManaged: false,
		};

		vi.spyOn(peopleApi, "fetchPersonObligation").mockResolvedValue({
			obligation: obligationWithSettlement,
		});
		vi.spyOn(peopleApi, "fetchObligationSettlements").mockResolvedValue({
			settlements: [],
			limit: 50,
			hasMore: false,
			nextCursor: null,
		});

		const conflictError = new ApiError({
			status: 409,
			code: "PEOPLE_OBLIGATION_SETTLEMENT_CONFLICT",
			message: "Settlement conflict",
		});

		vi.spyOn(peopleApi, "voidPersonObligation").mockRejectedValue(
			conflictError,
		);

		await renderWithRouter(
			<ObligationDetailPage personId="p1" obligationId="ob-conflict" />,
		);

		await waitFor(() => {
			expect(screen.getByTestId("void-obligation-btn")).toBeInTheDocument();
		});

		fireEvent.click(screen.getByTestId("void-obligation-btn"));

		await waitFor(() => {
			expect(screen.getByTestId("obligation-void-error")).toBeInTheDocument();
		});

		expect(screen.getByTestId("obligation-void-error")).toHaveTextContent(
			"Bu borç/alacak için daha önce ödeme kaydı bulunduğu için bu değişiklik yapılamıyor.",
		);
	});

	it("paginates payment history with exact opaque cursor", async () => {
		const obligation: ObligationProductDto = {
			obligationId: "ob-hist",
			personId: "p1",
			direction: "RECEIVABLE",
			status: "OPEN",
			principalAmount: "1000.00",
			settledAmount: "200.00",
			remainingAmount: "800.00",
			dueDate: null,
			description: "Taksitli",
			budgetCategory: null,
			revisionNo: 2,
			isSplitManaged: false,
		};

		vi.spyOn(peopleApi, "fetchPersonObligation").mockResolvedValue({
			obligation,
		});

		const mockFetchSettlements = vi
			.spyOn(peopleApi, "fetchObligationSettlements")
			.mockResolvedValueOnce({
				settlements: [
					{
						settlementId: "set-1",
						obligationId: "ob-hist",
						personId: "p1",
						direction: "RECEIVABLE",
						status: "ACTIVE",
						cashAmount: "100.00",
						appliedAmount: "100.00",
						excessAmount: "0.00",
						note: "1. taksit",
						occurredAt: "2026-03-01T10:00:00Z",
						revisionNo: 1,
					},
				],
				limit: 50,
				hasMore: true,
				nextCursor: "cursor_opaque_abc",
			})
			.mockResolvedValueOnce({
				settlements: [
					{
						settlementId: "set-2",
						obligationId: "ob-hist",
						personId: "p1",
						direction: "RECEIVABLE",
						status: "ACTIVE",
						cashAmount: "100.00",
						appliedAmount: "100.00",
						excessAmount: "0.00",
						note: "2. taksit",
						occurredAt: "2026-03-15T10:00:00Z",
						revisionNo: 1,
					},
				],
				limit: 50,
				hasMore: false,
				nextCursor: null,
			});

		await renderWithRouter(
			<ObligationDetailPage personId="p1" obligationId="ob-hist" />,
		);

		await waitFor(() => {
			expect(screen.getByText("1. taksit")).toBeInTheDocument();
		});

		expect(screen.getByTestId("load-more-settlements-btn")).toBeInTheDocument();

		fireEvent.click(screen.getByTestId("load-more-settlements-btn"));

		await waitFor(() => {
			expect(mockFetchSettlements).toHaveBeenCalledTimes(2);
		});

		// Verify 2nd call used opaque cursor parameter (after: cursor_opaque_abc)
		expect(mockFetchSettlements).toHaveBeenLastCalledWith(
			"p1",
			"ob-hist",
			expect.objectContaining({
				after: "cursor_opaque_abc",
			}),
		);

		await waitFor(() => {
			expect(screen.getByText("2. taksit")).toBeInTheDocument();
		});
	});
});

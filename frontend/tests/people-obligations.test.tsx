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

	it("R1: partial RECEIVABLE edit pre-fills principalAmount and preserves full principal on description edit", async () => {
		const initialObligation: ObligationProductDto = {
			obligationId: "ob-r1-rec",
			personId: "p1",
			direction: "RECEIVABLE",
			status: "OPEN",
			principalAmount: "500.00",
			settledAmount: "200.00",
			remainingAmount: "300.00",
			dueDate: "2026-05-01",
			description: "Eski açıklama",
			budgetCategory: null,
			revisionNo: 4,
			isSplitManaged: false,
		};

		vi.spyOn(peopleApi, "fetchPersonObligation").mockResolvedValue({
			obligation: initialObligation,
		});

		const mockUpdate = vi
			.spyOn(peopleApi, "updatePersonObligation")
			.mockResolvedValue({
				obligation: {
					...initialObligation,
					description: "Yeni açıklama",
					revisionNo: 5,
				},
			});

		render(
			<ObligationForm mode="edit" personId="p1" obligationId="ob-r1-rec" />,
			{ wrapper: createWrapper() },
		);

		await waitFor(() => {
			expect(screen.getByLabelText(/Tutar/i)).toHaveValue("500.00");
		});

		const amountInput = screen.getByLabelText(/Tutar/i) as HTMLInputElement;
		// Must prefill principalAmount (500.00), NEVER remainingAmount (300.00)
		expect(amountInput.value).toBe("500.00");
		expect(amountInput.value).not.toBe("300.00");

		// Change only description
		const descInput = screen.getByTestId("obligation-description-input");
		fireEvent.change(descInput, { target: { value: "Yeni açıklama" } });

		fireEvent.click(screen.getByTestId("obligation-submit-btn"));

		await waitFor(() => {
			expect(mockUpdate).toHaveBeenCalledTimes(1);
		});

		const [personIdArg, obligationIdArg, payload] = mockUpdate.mock.calls[0]!;
		expect(personIdArg).toBe("p1");
		expect(obligationIdArg).toBe("ob-r1-rec");
		expect(payload).toEqual(
			expect.objectContaining({
				expectedRevisionNo: 4,
				amount: "500.00",
				description: "Yeni açıklama",
				dueDate: "2026-05-01",
			}),
		);
	});

	it("R1: partial PAYABLE edit pre-fills principalAmount and preserves full principal", async () => {
		const initialObligation: ObligationProductDto = {
			obligationId: "ob-r1-pay",
			personId: "p1",
			direction: "PAYABLE",
			status: "OPEN",
			principalAmount: "750.00",
			settledAmount: "250.00",
			remainingAmount: "500.00",
			dueDate: null,
			description: "Kira ortaklığı",
			budgetCategory: "MANDATORY_EXPENSE",
			revisionNo: 2,
			isSplitManaged: false,
		};

		vi.spyOn(peopleApi, "fetchPersonObligation").mockResolvedValue({
			obligation: initialObligation,
		});

		const mockUpdate = vi
			.spyOn(peopleApi, "updatePersonObligation")
			.mockResolvedValue({
				obligation: {
					...initialObligation,
					description: "Kira ortaklığı revize",
					revisionNo: 3,
				},
			});

		render(
			<ObligationForm mode="edit" personId="p1" obligationId="ob-r1-pay" />,
			{ wrapper: createWrapper() },
		);

		await waitFor(() => {
			expect(screen.getByLabelText(/Tutar/i)).toHaveValue("750.00");
		});

		const amountInput = screen.getByLabelText(/Tutar/i) as HTMLInputElement;
		// Must prefill 750.00, not 500.00
		expect(amountInput.value).toBe("750.00");
		expect(amountInput.value).not.toBe("500.00");

		const descInput = screen.getByTestId("obligation-description-input");
		fireEvent.change(descInput, { target: { value: "Kira ortaklığı revize" } });

		fireEvent.click(screen.getByTestId("obligation-submit-btn"));

		await waitFor(() => {
			expect(mockUpdate).toHaveBeenCalledTimes(1);
		});

		const [, , payload] = mockUpdate.mock.calls[0]!;
		expect(payload.amount).toBe("750.00");
		expect(payload.expectedRevisionNo).toBe(2);
		expect(payload.budgetCategory).toBe("MANDATORY_EXPENSE");
	});

	it("R2: receivable create uncertain retry uses exact same Idempotency-Key, payload, and occurredAt", async () => {
		const networkError = new ApiError({
			status: 0,
			code: "NETWORK_ERROR",
			message: "Network failure during POST",
		});

		const mockCreate = vi
			.spyOn(peopleApi, "createPersonReceivable")
			.mockRejectedValueOnce(networkError)
			.mockResolvedValueOnce({
				obligation: {
					obligationId: "ob-created",
					personId: "p1",
					direction: "RECEIVABLE",
					status: "OPEN",
					principalAmount: "100.00",
					settledAmount: "0.00",
					remainingAmount: "100.00",
					dueDate: null,
					description: "Uncertain test",
					budgetCategory: null,
					revisionNo: 1,
					isSplitManaged: false,
				},
			});

		render(
			<ObligationForm
				mode="create"
				personId="p1"
				initialDirection="RECEIVABLE"
			/>,
			{ wrapper: createWrapper() },
		);

		await waitFor(() => {
			expect(
				screen.getByTestId("obligation-funding-account-select"),
			).toBeInTheDocument();
		});

		// Fill form
		fireEvent.change(screen.getByLabelText(/Tutar/i), {
			target: { value: "100.00" },
		});
		fireEvent.change(screen.getByTestId("obligation-funding-account-select"), {
			target: { value: "acc-bank" },
		});
		fireEvent.change(screen.getByLabelText(/Açıklama/i), {
			target: { value: "Uncertain test" },
		});

		// Submit 1
		fireEvent.click(screen.getByTestId("obligation-submit-btn"));

		await waitFor(() => {
			expect(mockCreate).toHaveBeenCalledTimes(1);
		});

		// Uncertain alert is displayed
		expect(
			await screen.findByTestId("obligation-uncertain-alert"),
		).toBeInTheDocument();
		expect(screen.getByTestId("obligation-uncertain-alert")).toHaveTextContent(
			"Kaydın tamamlanıp tamamlanmadığı doğrulanamadı. Aynı işlemi güvenli şekilde tekrar kontrol edebilirsiniz.",
		);

		// Retry
		fireEvent.click(screen.getByTestId("retry-uncertain-btn"));

		await waitFor(() => {
			expect(mockCreate).toHaveBeenCalledTimes(2);
		});

		const [call1Person, call1Payload, call1Key] = mockCreate.mock.calls[0]!;
		const [call2Person, call2Payload, call2Key] = mockCreate.mock.calls[1]!;

		expect(call1Person).toBe("p1");
		expect(call2Person).toBe("p1");
		expect(call2Key).toBe(call1Key);
		expect(call2Payload).toEqual(call1Payload);
		expect(call2Payload.occurredAt).toBe(call1Payload.occurredAt);
	});

	it("R2: payable create uncertain retry uses exact same Idempotency-Key, payload, and occurredAt", async () => {
		const networkError = new ApiError({
			status: 0,
			code: "NETWORK_ERROR",
			message: "Network timeout",
		});

		const mockCreate = vi
			.spyOn(peopleApi, "createPersonPayable")
			.mockRejectedValueOnce(networkError)
			.mockResolvedValueOnce({
				obligation: {
					obligationId: "ob-pay-unc",
					personId: "p1",
					direction: "PAYABLE",
					status: "OPEN",
					principalAmount: "250.00",
					settledAmount: "0.00",
					remainingAmount: "250.00",
					dueDate: null,
					description: "Payable uncertain",
					budgetCategory: "MANDATORY_EXPENSE",
					revisionNo: 1,
					isSplitManaged: false,
				},
			});

		render(
			<ObligationForm mode="create" personId="p1" initialDirection="PAYABLE" />,
			{ wrapper: createWrapper() },
		);

		fireEvent.change(screen.getByLabelText(/Tutar/i), {
			target: { value: "250.00" },
		});
		fireEvent.click(screen.getByTestId("budget-mandatory"));
		fireEvent.change(screen.getByLabelText(/Açıklama/i), {
			target: { value: "Payable uncertain" },
		});

		fireEvent.click(screen.getByTestId("obligation-submit-btn"));

		await waitFor(() => {
			expect(mockCreate).toHaveBeenCalledTimes(1);
		});

		expect(
			await screen.findByTestId("retry-uncertain-btn"),
		).toBeInTheDocument();

		fireEvent.click(screen.getByTestId("retry-uncertain-btn"));

		await waitFor(() => {
			expect(mockCreate).toHaveBeenCalledTimes(2);
		});

		const [, call1Payload, call1Key] = mockCreate.mock.calls[0]!;
		const [, call2Payload, call2Key] = mockCreate.mock.calls[1]!;

		expect(call2Key).toBe(call1Key);
		expect(call2Payload).toEqual(call1Payload);
		expect(call2Payload.occurredAt).toBe(call1Payload.occurredAt);
	});

	it("R2: obligation edit uncertain retry uses exact same Idempotency-Key, payload, and occurredAt", async () => {
		const initialObligation: ObligationProductDto = {
			obligationId: "ob-edit-unc",
			personId: "p1",
			direction: "RECEIVABLE",
			status: "OPEN",
			principalAmount: "400.00",
			settledAmount: "0.00",
			remainingAmount: "400.00",
			dueDate: null,
			description: "Edit uncertain",
			budgetCategory: null,
			revisionNo: 2,
			isSplitManaged: false,
		};

		const networkError = new ApiError({
			status: 0,
			code: "NETWORK_ERROR",
			message: "Failed to fetch",
		});

		vi.spyOn(peopleApi, "fetchPersonObligation").mockResolvedValue({
			obligation: initialObligation,
		});

		const mockUpdate = vi
			.spyOn(peopleApi, "updatePersonObligation")
			.mockRejectedValueOnce(networkError)
			.mockResolvedValueOnce({
				obligation: {
					...initialObligation,
					description: "Edit uncertain updated",
					revisionNo: 3,
				},
			});

		render(
			<ObligationForm mode="edit" personId="p1" obligationId="ob-edit-unc" />,
			{ wrapper: createWrapper() },
		);

		await waitFor(() => {
			expect(screen.getByLabelText(/Tutar/i)).toHaveValue("400.00");
		});

		fireEvent.change(screen.getByTestId("obligation-description-input"), {
			target: { value: "Edit uncertain updated" },
		});

		fireEvent.click(screen.getByTestId("obligation-submit-btn"));

		await waitFor(() => {
			expect(mockUpdate).toHaveBeenCalledTimes(1);
		});

		expect(
			await screen.findByTestId("retry-uncertain-btn"),
		).toBeInTheDocument();

		fireEvent.click(screen.getByTestId("retry-uncertain-btn"));

		await waitFor(() => {
			expect(mockUpdate).toHaveBeenCalledTimes(2);
		});

		const [, , call1Payload, call1Key] = mockUpdate.mock.calls[0]!;
		const [, , call2Payload, call2Key] = mockUpdate.mock.calls[1]!;

		expect(call2Key).toBe(call1Key);
		expect(call2Payload).toEqual(call1Payload);
		expect(call2Payload.occurredAt).toBe(call1Payload.occurredAt);
		expect(call2Payload.expectedRevisionNo).toBe(2);
		expect(call2Payload.amount).toBe("400.00");
	});

	it("R2: obligation void uncertain retry resends same key and revision without prompting window.confirm again", async () => {
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

		const obligation: ObligationProductDto = {
			obligationId: "ob-void-unc",
			personId: "p1",
			direction: "RECEIVABLE",
			status: "OPEN",
			principalAmount: "300.00",
			settledAmount: "0.00",
			remainingAmount: "300.00",
			dueDate: null,
			description: "Void uncertain",
			budgetCategory: null,
			revisionNo: 5,
			isSplitManaged: false,
		};

		vi.spyOn(peopleApi, "fetchPersonObligation").mockResolvedValue({
			obligation,
		});
		vi.spyOn(peopleApi, "fetchObligationSettlements").mockResolvedValue({
			settlements: [],
			limit: 50,
			hasMore: false,
			nextCursor: null,
		});

		const networkError = new ApiError({
			status: 0,
			code: "NETWORK_ERROR",
			message: "Connection dropped",
		});

		const mockVoid = vi
			.spyOn(peopleApi, "voidPersonObligation")
			.mockRejectedValueOnce(networkError)
			.mockResolvedValueOnce({
				obligation: { ...obligation, status: "VOID", revisionNo: 6 },
			});

		await renderWithRouter(
			<ObligationDetailPage personId="p1" obligationId="ob-void-unc" />,
		);

		await waitFor(() => {
			expect(screen.getByTestId("void-obligation-btn")).toBeInTheDocument();
		});

		fireEvent.click(screen.getByTestId("void-obligation-btn"));

		await waitFor(() => {
			expect(mockVoid).toHaveBeenCalledTimes(1);
		});

		expect(confirmSpy).toHaveBeenCalledTimes(1);
		expect(
			await screen.findByTestId("retry-uncertain-void-btn"),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"İptal işleminin tamamlanıp tamamlanmadığı doğrulanamadı.",
			),
		).toBeInTheDocument();

		// Retry void without confirming again
		fireEvent.click(screen.getByTestId("retry-uncertain-void-btn"));

		await waitFor(() => {
			expect(mockVoid).toHaveBeenCalledTimes(2);
		});

		// confirm must NOT have been called a second time
		expect(confirmSpy).toHaveBeenCalledTimes(1);

		const [, , call1Payload, call1Key] = mockVoid.mock.calls[0]!;
		const [, , call2Payload, call2Key] = mockVoid.mock.calls[1]!;

		expect(call2Key).toBe(call1Key);
		expect(call2Payload).toEqual(call1Payload);
		expect(call2Payload.expectedRevisionNo).toBe(5);
	});

	it("R3: settlement history displays Istanbul timezone representation instead of UTC date slice", async () => {
		const obligation: ObligationProductDto = {
			obligationId: "ob-r3",
			personId: "p1",
			direction: "RECEIVABLE",
			status: "OPEN",
			principalAmount: "500.00",
			settledAmount: "100.00",
			remainingAmount: "400.00",
			dueDate: null,
			description: "R3 test",
			budgetCategory: null,
			revisionNo: 1,
			isSplitManaged: false,
		};

		vi.spyOn(peopleApi, "fetchPersonObligation").mockResolvedValue({
			obligation,
		});
		vi.spyOn(peopleApi, "fetchObligationSettlements").mockResolvedValue({
			settlements: [
				{
					settlementId: "set-boundary",
					obligationId: "ob-r3",
					personId: "p1",
					direction: "RECEIVABLE",
					status: "ACTIVE",
					cashAmount: "100.00",
					appliedAmount: "100.00",
					excessAmount: "0.00",
					note: "Boundary settlement",
					// UTC: 2026-09-30 21:30:00 -> Istanbul: 2026-10-01 00:30:00
					occurredAt: "2026-09-30T21:30:00.000Z",
					revisionNo: 1,
				},
			],
			limit: 50,
			hasMore: false,
			nextCursor: null,
		});

		await renderWithRouter(
			<ObligationDetailPage personId="p1" obligationId="ob-r3" />,
		);

		await waitFor(() => {
			expect(
				screen.getByTestId("settlement-row-set-boundary"),
			).toBeInTheDocument();
		});

		const row = screen.getByTestId("settlement-row-set-boundary");

		// Must display Istanbul date representation "1 Ekim 2026"
		expect(row).toHaveTextContent("1 Ekim 2026");
		expect(row).toHaveTextContent("00:30");

		// Must NOT display UTC calendar date slice "2026-09-30"
		expect(row).not.toHaveTextContent("2026-09-30");
	});
});

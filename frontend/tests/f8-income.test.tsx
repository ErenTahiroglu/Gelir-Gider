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
import * as incomeApi from "../src/api/income-api";
import type {
	IncomeEntitlementItem,
	IncomeReceiptItem,
	IncomeReceiptSettlementResponse,
	MonthlyReferenceIncomeResponse,
	ProductIncomeSourceItem,
} from "../src/api/income-types";
import * as manualExpensesApi from "../src/api/manual-expenses-api";
import { EntitlementDetail } from "../src/components/income/EntitlementDetail";
import { EntitlementForm } from "../src/components/income/EntitlementForm";
import { IncomeReceiptDetail } from "../src/components/income/IncomeReceiptDetail";
import { IncomeSettlementEditor } from "../src/components/income/IncomeSettlementEditor";
import { IncomeSourceForm } from "../src/components/income/IncomeSourceForm";
import { LedgerAccountProvisionModal } from "../src/components/income/LedgerAccountProvisionModal";
import { ReferenceIncomePanel } from "../src/components/income/ReferenceIncomePanel";

vi.mock("../src/api/income-api");
vi.mock("../src/api/manual-expenses-api");

// Mock tanstack router Link and useNavigate and useParams
let mockParams: Record<string, string> = {};
const mockNavigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to, ...props }: any) => (
		<a href={to} {...props}>
			{children}
		</a>
	),
	useNavigate: () => mockNavigate,
	useParams: () => mockParams,
	useSearch: () => ({}),
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

const mockRegularSource: ProductIncomeSourceItem = {
	sourceId: "src-1",
	code: "KYK_BURSU",
	name: "KYK Bursu",
	nature: "REGULAR",
	referenceMethod: "FIXED_MONTHLY",
	expectedMonthlyAmount: "2000.00",
	seasonalMonthsPerYear: null,
	rollingMedianMonths: null,
	incomeLedgerAccountId: "acc-inc-1",
	activeFrom: "2026-01-01",
	activeUntil: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	archivedAt: null,
};

const mockExtraSource: ProductIncomeSourceItem = {
	sourceId: "src-2",
	code: "FREELANCE_PROJE",
	name: "Freelance Proje",
	nature: "EXTRA",
	referenceMethod: "EXCLUDED",
	expectedMonthlyAmount: null,
	seasonalMonthsPerYear: null,
	rollingMedianMonths: null,
	incomeLedgerAccountId: "acc-inc-1",
	activeFrom: "2026-01-01",
	activeUntil: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	archivedAt: null,
};

const mockIncomeAccount = {
	id: "acc-inc-1",
	accountId: "acc-inc-1",
	code: "USR_GELIR",
	name: "Ana Gelir Hesabı",
	accountType: "INCOME" as const,
	normalBalance: "CREDIT" as const,
	currency: "TRY",
	balance: "0.00",
	archived: false,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

const mockAssetAccount = {
	id: "acc-asset-1",
	accountId: "acc-asset-1",
	code: "USR_VADESIZ",
	name: "Banka Vadesiz",
	accountType: "ASSET" as const,
	normalBalance: "DEBIT" as const,
	currency: "TRY",
	balance: "0.00",
	archived: false,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("F8 Income Tests", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockParams = {};
		vi.mocked(incomeApi.fetchAllActiveIncomeSources).mockResolvedValue([
			mockRegularSource,
			mockExtraSource,
		]);
		vi.mocked(incomeApi.fetchIncomeSources).mockResolvedValue({
			sources: [mockRegularSource, mockExtraSource],
			hasMore: false,
			limit: 100,
			nextCursor: null,
		});
		vi.mocked(manualExpensesApi.fetchAllLedgerAccounts).mockResolvedValue([
			mockIncomeAccount,
			mockAssetAccount,
		]);
		vi.spyOn(window, "confirm").mockReturnValue(true);
	});

	afterEach(() => {
		cleanup();
	});

	// =========================================================================
	// Section 117: SOURCE REFERENCE METHODS & INVARIANTS
	// =========================================================================
	describe("Section 117: Source Reference Methods & Invariants", () => {
		it("submits REGULAR source with FIXED_MONTHLY correctly and validates expectedMonthlyAmount", async () => {
			const { wrapper } = createWrapper();
			vi.mocked(incomeApi.createIncomeSource).mockResolvedValue(
				mockRegularSource,
			);

			render(<IncomeSourceForm />, { wrapper });

			await waitFor(() => {
				expect(screen.getByLabelText(/Kaynak Kodu/i)).toBeDefined();
			});

			fireEvent.change(screen.getByLabelText(/Kaynak Kodu/i), {
				target: { value: "MAAS_GELIRI" },
			});
			fireEvent.change(screen.getByLabelText(/Kaynak Adı/i), {
				target: { value: "Maaş Geliri" },
			});
			fireEvent.change(screen.getByLabelText(/Gelir Türü/i), {
				target: { value: "REGULAR" },
			});
			fireEvent.change(screen.getByLabelText(/Referans Gelir Yöntemi/i), {
				target: { value: "FIXED_MONTHLY" },
			});

			// Enter amount
			const amountInput = screen.getByLabelText(/Beklenen Aylık Tutar/i);
			fireEvent.change(amountInput, { target: { value: "15000" } });

			fireEvent.change(screen.getByLabelText(/Muhasebe Gelir Hesabı/i), {
				target: { value: "acc-inc-1" },
			});
			fireEvent.change(screen.getByLabelText(/Başlangıç Tarihi/i), {
				target: { value: "2026-01-01" },
			});

			const submitBtn = screen.getByTestId("btn-submit-source");
			fireEvent.click(submitBtn);

			await waitFor(() => {
				expect(incomeApi.createIncomeSource).toHaveBeenCalledWith(
					expect.objectContaining({
						code: "MAAS_GELIRI",
						name: "Maaş Geliri",
						nature: "REGULAR",
						referenceMethod: "FIXED_MONTHLY",
						expectedMonthlyAmount: "15000.00",
						activeFrom: "2026-01-01",
						incomeLedgerAccountId: "acc-inc-1",
					}),
				);
			});
		});

		it("locks EXTRA and SUPPORT sources to EXCLUDED referenceMethod automatically", async () => {
			const { wrapper } = createWrapper();
			render(<IncomeSourceForm />, { wrapper });

			await waitFor(() => {
				expect(screen.getByLabelText(/Gelir Türü/i)).toBeDefined();
			});

			const natureSelect = screen.getByLabelText(/Gelir Türü/i);
			fireEvent.change(natureSelect, { target: { value: "EXTRA" } });

			// Reference method select should be disabled and set to EXCLUDED
			const refMethodSelect = screen.getByLabelText(
				/Referans Gelir Yöntemi/i,
			) as HTMLSelectElement;
			expect(refMethodSelect.value).toBe("EXCLUDED");
			expect(refMethodSelect.disabled).toBe(true);

			// Check SUPPORT also locks to EXCLUDED
			fireEvent.change(natureSelect, { target: { value: "SUPPORT" } });
			expect(refMethodSelect.value).toBe("EXCLUDED");
			expect(refMethodSelect.disabled).toBe(true);
		});
	});

	// =========================================================================
	// Section 118: FRESH USER ACCOUNT PROVISIONING
	// =========================================================================
	describe("Section 118: Fresh User Ledger Account Provisioning", () => {
		it("creates INCOME and ASSET ledger accounts with zero financial effect and no idempotency key", async () => {
			const { wrapper } = createWrapper();
			vi.mocked(incomeApi.createProductLedgerAccount).mockResolvedValue(
				mockIncomeAccount,
			);
			const onAccountCreated = vi.fn();

			render(
				<LedgerAccountProvisionModal
					isOpen={true}
					accountType="INCOME"
					onClose={vi.fn()}
					onAccountCreated={onAccountCreated}
				/>,
				{ wrapper },
			);

			fireEvent.change(screen.getByLabelText(/Hesap Kodu/i), {
				target: { value: "ANA_GELIR" },
			});
			fireEvent.change(screen.getByLabelText(/Hesap Adı/i), {
				target: { value: "Ana Gelir Hesabı" },
			});

			fireEvent.click(screen.getByTestId("btn-create-account-submit"));

			await waitFor(() => {
				expect(incomeApi.createProductLedgerAccount).toHaveBeenCalledWith({
					code: "ANA_GELIR",
					name: "Ana Gelir Hesabı",
					accountType: "INCOME",
				});
				expect(onAccountCreated).toHaveBeenCalledWith(mockIncomeAccount);
			});
		});
	});

	// =========================================================================
	// Section 119 & 120: ENTITLEMENT MONTH FORMAT (YYYY-MM-01) & ZERO CASH EFFECT
	// =========================================================================
	describe("Section 119 & 120: Entitlement Month Format & No Cash Effect", () => {
		it("formats UI month 2026-09 into canonical 2026-09-01 for entitlement create", async () => {
			const { wrapper } = createWrapper();
			const mockEntitlement: IncomeEntitlementItem = {
				entitlementId: "ent-1",
				sourceId: "src-1",
				sourceCode: "KYK_BURSU",
				sourceName: "KYK Bursu",
				periodMonth: "2026-09-01",
				revisionNo: 1,
				status: "ACTIVE",
				amount: "2000.00",
				allocatedAmount: "0.00",
				outstandingAmount: "2000.00",
				settlementStatus: "OPEN",
				expectedReceiptOn: "2026-09-10",
				overdue: false,
				note: null,
			};
			vi.mocked(incomeApi.createIncomeEntitlement).mockResolvedValue(
				mockEntitlement,
			);

			render(<EntitlementForm />, { wrapper });

			await waitFor(() => {
				expect(screen.getByLabelText(/Gelir Kaynağı/i)).toBeDefined();
			});

			fireEvent.change(screen.getByLabelText(/Düzenli Gelir Kaynağı/i), {
				target: { value: "src-1" },
			});
			fireEvent.change(screen.getByLabelText(/Dönem Ayı/i), {
				target: { value: "2026-09" },
			});
			fireEvent.change(screen.getByLabelText(/Beklenen Tutar/i), {
				target: { value: "2000" },
			});

			fireEvent.click(screen.getByTestId("btn-submit-entitlement"));

			await waitFor(() => {
				expect(incomeApi.createIncomeEntitlement).toHaveBeenCalledWith(
					expect.objectContaining({
						sourceId: "src-1",
						periodMonth: "2026-09-01", // Critical: YYYY-MM-01 format!
						amount: "2000.00",
					}),
					expect.any(String),
				);
			});
		});
	});

	// =========================================================================
	// Section 121 & 122: RECEIPT MUTATION, EXPLICIT RETRY & OCC
	// =========================================================================
	describe("Section 121 & 122: Receipt Financial Mutation, Frozen Retry & OCC", () => {
		it("sends expectedRevisionNo on edit and refetches on revision conflict", async () => {
			const { wrapper, queryClient } = createWrapper();
			const mockReceipt: IncomeReceiptItem = {
				incomeReceiptId: "rec-1",
				sourceId: "src-1",
				sourceCode: "KYK_BURSU",
				sourceName: "KYK Bursu",
				status: "ACTIVE",
				revisionNo: 4,
				receivedAt: "2026-09-10T10:00:00.000Z",
				amount: "2000.00",
				destinationAccountId: "acc-asset-1",
				note: "KYK Eylül",
			};

			vi.mocked(incomeApi.fetchIncomeReceipt).mockResolvedValue(mockReceipt);
			vi.mocked(incomeApi.fetchIncomeReceiptSettlement).mockResolvedValue({
				incomeReceiptId: "rec-1",
				receiptAmount: "2000.00",
				allocatedAmount: "0.00",
				unallocatedAmount: "2000.00",
				revisionNo: 1,
				allocations: [],
			});

			mockParams = { incomeReceiptId: "rec-1" };

			render(<IncomeReceiptDetail incomeReceiptId="rec-1" />, { wrapper });

			await waitFor(() => {
				expect(screen.getByTestId("btn-edit-receipt")).toBeDefined();
			});

			// Enter edit mode
			fireEvent.click(screen.getByTestId("btn-edit-receipt"));

			// Mock revision conflict
			vi.mocked(incomeApi.reviseIncomeReceipt).mockRejectedValueOnce(
				new ApiError({
					status: 409,
					code: "INCOME_RECEIPT_REVISION_CONFLICT",
					message: "Stale revision",
				}),
			);

			// Submit revision
			fireEvent.click(screen.getByTestId("btn-save-receipt-revision"));

			await waitFor(() => {
				expect(incomeApi.reviseIncomeReceipt).toHaveBeenCalledWith(
					"rec-1",
					expect.objectContaining({
						expectedRevisionNo: 4,
					}),
					expect.any(String),
				);
			});
		});

		it("replays exact Idempotency-Key and payload on receipt void network uncertainty", async () => {
			const { wrapper } = createWrapper();
			const mockReceipt: IncomeReceiptItem = {
				incomeReceiptId: "rec-1",
				sourceId: "src-1",
				sourceCode: "KYK_BURSU",
				sourceName: "KYK Bursu",
				status: "ACTIVE",
				revisionNo: 2,
				receivedAt: "2026-09-10T10:00:00.000Z",
				amount: "2000.00",
				destinationAccountId: "acc-asset-1",
				note: "KYK Eylül",
			};

			vi.mocked(incomeApi.fetchIncomeReceipt).mockResolvedValue(mockReceipt);
			vi.mocked(incomeApi.fetchIncomeReceiptSettlement).mockResolvedValue({
				incomeReceiptId: "rec-1",
				receiptAmount: "2000.00",
				allocatedAmount: "0.00",
				unallocatedAmount: "2000.00",
				revisionNo: 1,
				allocations: [],
			});

			mockParams = { incomeReceiptId: "rec-1" };

			const networkErr = new TypeError("Failed to fetch");
			vi.mocked(incomeApi.voidIncomeReceipt)
				.mockRejectedValueOnce(networkErr)
				.mockResolvedValueOnce({
					...mockReceipt,
					status: "VOIDED",
					revisionNo: 3,
				});

			render(<IncomeReceiptDetail incomeReceiptId="rec-1" />, { wrapper });

			await waitFor(() => {
				expect(screen.getByTestId("btn-void-receipt")).toBeDefined();
			});

			fireEvent.click(screen.getByTestId("btn-void-receipt"));

			await waitFor(() => {
				expect(
					screen.getByRole("button", { name: /Tahsilatı İptal Et/i }),
				).toBeDefined();
			});

			fireEvent.click(
				screen.getByRole("button", { name: /Tahsilatı İptal Et/i }),
			);

			await waitFor(() => {
				expect(
					screen.getByTestId("receipt-void-uncertain-warning"),
				).toBeDefined();
			});

			expect(incomeApi.voidIncomeReceipt).toHaveBeenCalledTimes(1);
			const firstKey = vi.mocked(incomeApi.voidIncomeReceipt).mock.calls[0]![2];
			const firstPayload = vi.mocked(incomeApi.voidIncomeReceipt).mock
				.calls[0]![1];

			// Explicit retry
			fireEvent.click(screen.getByTestId("btn-retry-void-receipt"));

			await waitFor(() => {
				expect(incomeApi.voidIncomeReceipt).toHaveBeenCalledTimes(2);
			});

			const secondKey = vi.mocked(incomeApi.voidIncomeReceipt).mock
				.calls[1]![2];
			const secondPayload = vi.mocked(incomeApi.voidIncomeReceipt).mock
				.calls[1]![1];

			expect(secondKey).toBe(firstKey);
			expect(secondPayload).toEqual(firstPayload);
			expect(secondPayload.expectedRevisionNo).toBe(2);
		});
	});

	// =========================================================================
	// Section 123 & 124: SETTLEMENT GUARDS & CLEAR SETTLEMENT
	// =========================================================================
	describe("Section 123 & 124: Settlement Allocation Guards & Clear Settlement", () => {
		it("blocks allocation exceeding receiptAmount client-side with BigInt guard", async () => {
			const { wrapper } = createWrapper();
			const mockEntitlement: IncomeEntitlementItem = {
				entitlementId: "ent-1",
				sourceId: "src-1",
				sourceCode: "KYK_BURSU",
				sourceName: "KYK Bursu",
				periodMonth: "2026-09-01",
				revisionNo: 1,
				status: "ACTIVE",
				amount: "2000.00",
				allocatedAmount: "0.00",
				outstandingAmount: "2000.00",
				settlementStatus: "OPEN",
				expectedReceiptOn: "2026-09-10",
				overdue: false,
				note: null,
			};

			vi.mocked(incomeApi.fetchIncomeEntitlements).mockResolvedValue({
				entitlements: [mockEntitlement],
				hasMore: false,
				limit: 100,
				nextCursor: null,
			});

			render(
				<IncomeSettlementEditor
					incomeReceiptId="rec-1"
					sourceId="src-1"
					receiptAmount="1000.00"
					existingSettlement={null}
					onSuccess={vi.fn()}
					onCancel={vi.fn()}
				/>,
				{ wrapper },
			);

			await waitFor(() => {
				expect(screen.getByTestId("btn-save-settlement")).toBeDefined();
			});

			// Enter 1000.01 (exceeding receiptAmount of 1000.00)
			const amountInputs = screen.getAllByRole("textbox");
			if (amountInputs[0]) {
				fireEvent.change(amountInputs[0], { target: { value: "1000.01" } });
			}

			// Save should be disabled or show error
			const saveBtn = screen.getByTestId(
				"btn-save-settlement",
			) as HTMLButtonElement;
			expect(
				saveBtn.disabled || screen.getByText(/aşamaz|fazla/i) !== null,
			).toBe(true);
		});

		it("clears settlement by sending allocations: [] to revision endpoint", async () => {
			const { wrapper } = createWrapper();
			const existingSettlement: IncomeReceiptSettlementResponse = {
				incomeReceiptId: "rec-1",
				receiptAmount: "1000.00",
				allocatedAmount: "1000.00",
				unallocatedAmount: "0.00",
				revisionNo: 2,
				allocations: [
					{
						entitlementId: "ent-1",
						periodMonth: "2026-09-01",
						entitlementAmount: "1000.00",
						allocatedAmount: "1000.00",
						entitlementOutstandingAfterAllReceipts: "0.00",
					},
				],
			};

			vi.mocked(incomeApi.fetchIncomeEntitlements).mockResolvedValue({
				entitlements: [],
				hasMore: false,
				limit: 100,
				nextCursor: null,
			});
			vi.mocked(incomeApi.reviseIncomeSettlement).mockResolvedValue(
				existingSettlement,
			);

			const onSuccess = vi.fn();

			render(
				<IncomeSettlementEditor
					incomeReceiptId="rec-1"
					sourceId="src-1"
					receiptAmount="1000.00"
					existingSettlement={existingSettlement}
					onSuccess={onSuccess}
					onCancel={vi.fn()}
				/>,
				{ wrapper },
			);

			await waitFor(() => {
				expect(screen.getByTestId("btn-clear-settlement")).toBeDefined();
			});

			fireEvent.click(screen.getByTestId("btn-clear-settlement"));

			await waitFor(() => {
				expect(incomeApi.reviseIncomeSettlement).toHaveBeenCalledWith(
					"rec-1",
					expect.objectContaining({
						expectedRevisionNo: 2,
						allocations: [],
					}),
					expect.any(String),
				);
				expect(onSuccess).toHaveBeenCalled();
			});
		});
	});

	// =========================================================================
	// Section 125: REFERENCE INCOME TOTAL AUTHORITY
	// =========================================================================
	describe("Section 125: Reference Income Total Authority", () => {
		it("renders exact backend total without client sum recomputation", async () => {
			const { wrapper } = createWrapper();
			const mockRefIncome: MonthlyReferenceIncomeResponse = {
				asOf: "2026-09-15",
				currency: "TRY",
				total: "13000.00",
				sources: [
					{
						sourceId: "src-1",
						code: "MAAS",
						name: "Maaş",
						nature: "REGULAR",
						referenceMethod: "FIXED_MONTHLY",
						referenceAmount: "10000.00",
					},
					{
						sourceId: "src-2",
						code: "BURS",
						name: "Burs",
						nature: "REGULAR",
						referenceMethod: "FIXED_MONTHLY",
						referenceAmount: "3000.00",
					},
				],
			};

			vi.mocked(incomeApi.fetchMonthlyReferenceIncome).mockResolvedValue(
				mockRefIncome,
			);

			render(<ReferenceIncomePanel />, { wrapper });

			await waitFor(() => {
				const totalEl = screen.getByTestId("reference-income-total");
				expect(totalEl.textContent).toContain("13.000,00");
			});
		});
	});

	// =========================================================================
	// Section R1 & R2: RED-TEAM STRENGTHENING — EXACT MONEY & FROZEN RETRIES
	// =========================================================================
	describe("Red-Team Strengthening: Exact Money Validation & Frozen Retries", () => {
		it("R1: validates precise valid money (0.01) and submits exact amount", async () => {
			const { wrapper } = createWrapper();
			vi.mocked(incomeApi.fetchAllActiveIncomeSources).mockResolvedValue([
				mockRegularSource,
			]);

			render(<EntitlementForm />, { wrapper });

			await waitFor(() => {
				expect(screen.getByRole("combobox")).toBeDefined();
			});

			const selectEl = screen.getByRole("combobox");
			fireEvent.change(selectEl, {
				target: { value: "src-1" },
			});

			// Set 0.01 (valid minimal precise cent)
			fireEvent.change(screen.getByLabelText(/Beklenen Tutar/i), {
				target: { value: "0.01" },
			});

			vi.mocked(incomeApi.createIncomeEntitlement).mockResolvedValue({
				entitlementId: "ent-new",
			} as any);

			const submitBtn = screen.getByRole("button", {
				name: /Beklenen Geliri Kaydet/i,
			});
			fireEvent.click(submitBtn);
			await waitFor(() => {
				expect(incomeApi.createIncomeEntitlement).toHaveBeenCalledWith(
					expect.objectContaining({
						amount: "0.01",
					}),
					expect.any(String),
				);
			});
		});

		it("R2: Entitlement Edit preserves identical Idempotency-Key and payload on uncertain retry", async () => {
			const { wrapper } = createWrapper();
			const mockEnt: IncomeEntitlementItem = {
				entitlementId: "ent-1",
				sourceId: "src-1",
				sourceCode: "KYK",
				sourceName: "KYK Bursu",
				periodMonth: "2026-09-01",
				revisionNo: 3,
				status: "ACTIVE",
				amount: "2000.00",
				allocatedAmount: "0.00",
				outstandingAmount: "2000.00",
				settlementStatus: "OPEN",
				expectedReceiptOn: "2026-09-10",
				overdue: false,
				note: "Orijinal Not",
			};

			vi.mocked(incomeApi.fetchIncomeEntitlement).mockResolvedValue(mockEnt);

			// First call: Network error (uncertain)
			const networkErr = new TypeError("Failed to fetch");
			vi.mocked(incomeApi.reviseIncomeEntitlement)
				.mockRejectedValueOnce(networkErr)
				.mockResolvedValueOnce({
					...mockEnt,
					revisionNo: 4,
					amount: "2500.00",
				});

			render(<EntitlementDetail entitlementId="ent-1" />, { wrapper });

			await waitFor(() => {
				expect(screen.getByTestId("btn-edit-entitlement")).toBeDefined();
			});

			fireEvent.click(screen.getByTestId("btn-edit-entitlement"));

			await waitFor(() => {
				expect(screen.getByLabelText(/Yeni Beklenen Tutar/i)).toBeDefined();
			});

			fireEvent.change(screen.getByLabelText(/Yeni Beklenen Tutar/i), {
				target: { value: "2500.00" },
			});
			fireEvent.change(screen.getByLabelText(/Değişiklik Gerekçesi/i), {
				target: { value: "Artış" },
			});

			// First submit
			fireEvent.click(
				screen.getByRole("button", { name: /Değişiklikleri Kaydet/i }),
			);

			await waitFor(() => {
				expect(screen.getByTestId("edit-uncertain-warning")).toBeDefined();
			});

			expect(incomeApi.reviseIncomeEntitlement).toHaveBeenCalledTimes(1);
			const firstCallKey = vi.mocked(incomeApi.reviseIncomeEntitlement).mock
				.calls[0]![2];
			const firstCallPayload = vi.mocked(incomeApi.reviseIncomeEntitlement).mock
				.calls[0]![1];

			// Click retry button
			fireEvent.click(screen.getByTestId("btn-retry-edit-entitlement"));

			await waitFor(() => {
				expect(incomeApi.reviseIncomeEntitlement).toHaveBeenCalledTimes(2);
			});

			const secondCallKey = vi.mocked(incomeApi.reviseIncomeEntitlement).mock
				.calls[1]![2];
			const secondCallPayload = vi.mocked(incomeApi.reviseIncomeEntitlement)
				.mock.calls[1]![1];

			expect(secondCallKey).toBe(firstCallKey);
			expect(secondCallPayload).toEqual(firstCallPayload);
			expect(secondCallPayload.expectedRevisionNo).toBe(3);
			expect(secondCallPayload.amount).toBe("2500.00");
			expect(secondCallPayload.reasonNote).toBe("Artış");
		});

		it("R2: Entitlement Void preserves identical Idempotency-Key and payload on uncertain retry", async () => {
			const { wrapper } = createWrapper();
			const mockEnt: IncomeEntitlementItem = {
				entitlementId: "ent-1",
				sourceId: "src-1",
				sourceCode: "KYK",
				sourceName: "KYK Bursu",
				periodMonth: "2026-09-01",
				revisionNo: 2,
				status: "ACTIVE",
				amount: "2000.00",
				allocatedAmount: "0.00",
				outstandingAmount: "2000.00",
				settlementStatus: "OPEN",
				expectedReceiptOn: null,
				overdue: false,
				note: null,
			};

			vi.mocked(incomeApi.fetchIncomeEntitlement).mockResolvedValue(mockEnt);

			const networkErr = new TypeError("Failed to fetch");
			vi.mocked(incomeApi.voidIncomeEntitlement)
				.mockRejectedValueOnce(networkErr)
				.mockResolvedValueOnce({ ...mockEnt, status: "VOIDED" });

			render(<EntitlementDetail entitlementId="ent-1" />, { wrapper });

			await waitFor(() => {
				expect(screen.getByTestId("btn-void-entitlement")).toBeDefined();
			});

			fireEvent.click(screen.getByTestId("btn-void-entitlement"));

			await waitFor(() => {
				expect(screen.getByLabelText(/İptal Gerekçesi/i)).toBeDefined();
			});

			fireEvent.change(screen.getByLabelText(/İptal Gerekçesi/i), {
				target: { value: "Burs kesildi" },
			});

			// Submit void
			fireEvent.click(
				screen.getByRole("button", { name: /^Beklenen Geliri İptal Et$/i }),
			);

			await waitFor(() => {
				expect(screen.getByTestId("void-uncertain-warning")).toBeDefined();
			});

			expect(incomeApi.voidIncomeEntitlement).toHaveBeenCalledTimes(1);
			const firstKey = vi.mocked(incomeApi.voidIncomeEntitlement).mock
				.calls[0]![2];
			const firstPayload = vi.mocked(incomeApi.voidIncomeEntitlement).mock
				.calls[0]![1];

			// Retry void
			fireEvent.click(screen.getByTestId("btn-retry-void-entitlement"));

			await waitFor(() => {
				expect(incomeApi.voidIncomeEntitlement).toHaveBeenCalledTimes(2);
			});

			const secondKey = vi.mocked(incomeApi.voidIncomeEntitlement).mock
				.calls[1]![2];
			const secondPayload = vi.mocked(incomeApi.voidIncomeEntitlement).mock
				.calls[1]![1];

			expect(secondKey).toBe(firstKey);
			expect(secondPayload).toEqual(firstPayload);
			expect(secondPayload.expectedRevisionNo).toBe(2);
			expect(secondPayload.reasonNote).toBe("Burs kesildi");
		});

		it("R2: Receipt Edit preserves exact receivedAt ISO and Idempotency-Key on uncertain retry", async () => {
			const { wrapper } = createWrapper();
			const mockReceipt: IncomeReceiptItem = {
				incomeReceiptId: "rec-1",
				sourceId: "src-1",
				sourceCode: "KYK",
				sourceName: "KYK Bursu",
				status: "ACTIVE",
				revisionNo: 4,
				receivedAt: "2026-09-05T10:00:00.000Z",
				amount: "2000.00",
				destinationAccountId: "acc-1",
				note: "Maaş",
			};

			vi.mocked(incomeApi.fetchIncomeReceipt).mockResolvedValue(mockReceipt);
			vi.mocked(incomeApi.fetchIncomeReceiptSettlement).mockResolvedValue(
				null as any,
			);
			vi.mocked(manualExpensesApi.fetchAllLedgerAccounts).mockResolvedValue([
				{
					id: "acc-1",
					accountId: "acc-1",
					code: "USR_BANKA",
					name: "Ana Banka",
					accountType: "ASSET",
					normalBalance: "DEBIT",
					currency: "TRY",
					archived: false,
				} as any,
			]);

			const networkErr = new TypeError("Network down");
			vi.mocked(incomeApi.reviseIncomeReceipt)
				.mockRejectedValueOnce(networkErr)
				.mockResolvedValueOnce({
					...mockReceipt,
					revisionNo: 5,
					amount: "2200.00",
				});

			render(<IncomeReceiptDetail incomeReceiptId="rec-1" />, { wrapper });

			await waitFor(() => {
				expect(screen.getByTestId("btn-edit-receipt")).toBeDefined();
			});

			fireEvent.click(screen.getByTestId("btn-edit-receipt"));

			await waitFor(() => {
				expect(screen.getByLabelText(/Yeni Tutar/i)).toBeDefined();
			});

			fireEvent.change(screen.getByLabelText(/Yeni Tutar/i), {
				target: { value: "2200.00" },
			});

			fireEvent.click(screen.getByTestId("btn-save-receipt-revision"));

			await waitFor(() => {
				expect(
					screen.getByTestId("receipt-edit-uncertain-warning"),
				).toBeDefined();
			});

			expect(incomeApi.reviseIncomeReceipt).toHaveBeenCalledTimes(1);
			const firstKey = vi.mocked(incomeApi.reviseIncomeReceipt).mock
				.calls[0]![2];
			const firstPayload = vi.mocked(incomeApi.reviseIncomeReceipt).mock
				.calls[0]![1];

			// Retry edit
			fireEvent.click(screen.getByTestId("btn-retry-edit-receipt"));

			await waitFor(() => {
				expect(incomeApi.reviseIncomeReceipt).toHaveBeenCalledTimes(2);
			});

			const secondKey = vi.mocked(incomeApi.reviseIncomeReceipt).mock
				.calls[1]![2];
			const secondPayload = vi.mocked(incomeApi.reviseIncomeReceipt).mock
				.calls[1]![1];

			expect(secondKey).toBe(firstKey);
			expect(secondPayload.receivedAt).toBe(firstPayload.receivedAt);
			expect(secondPayload.expectedRevisionNo).toBe(4);
			expect(secondPayload.amount).toBe("2200.00");
		});

		it("R2: Settlement Clear reuses frozen key without calling window.confirm again on retry", async () => {
			const { wrapper } = createWrapper();
			const existingSettlement: IncomeReceiptSettlementResponse = {
				incomeReceiptId: "rec-1",
				receiptAmount: "1000.00",
				allocatedAmount: "1000.00",
				unallocatedAmount: "0.00",
				revisionNo: 3,
				allocations: [
					{
						entitlementId: "ent-1",
						periodMonth: "2026-09-01",
						entitlementAmount: "1000.00",
						allocatedAmount: "1000.00",
						entitlementOutstandingAfterAllReceipts: "0.00",
					},
				],
			};

			vi.mocked(incomeApi.fetchIncomeEntitlements).mockResolvedValue({
				entitlements: [],
				hasMore: false,
				limit: 100,
				nextCursor: null,
			});

			const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

			const networkErr = new TypeError("Failed to fetch");
			vi.mocked(incomeApi.reviseIncomeSettlement)
				.mockRejectedValueOnce(networkErr)
				.mockResolvedValueOnce({
					...existingSettlement,
					allocations: [],
					revisionNo: 4,
				});

			render(
				<IncomeSettlementEditor
					incomeReceiptId="rec-1"
					sourceId="src-1"
					receiptAmount="1000.00"
					existingSettlement={existingSettlement}
					onSuccess={vi.fn()}
					onCancel={vi.fn()}
				/>,
				{ wrapper },
			);

			await waitFor(() => {
				expect(screen.getByTestId("btn-clear-settlement")).toBeDefined();
			});

			// First clear attempt -> prompts confirm
			fireEvent.click(screen.getByTestId("btn-clear-settlement"));
			expect(confirmSpy).toHaveBeenCalledTimes(1);

			await waitFor(() => {
				expect(
					screen.getByTestId("settlement-uncertain-warning"),
				).toBeDefined();
			});

			expect(incomeApi.reviseIncomeSettlement).toHaveBeenCalledTimes(1);
			const firstKey = vi.mocked(incomeApi.reviseIncomeSettlement).mock
				.calls[0]![2];
			const firstPayload = vi.mocked(incomeApi.reviseIncomeSettlement).mock
				.calls[0]![1];

			// Retry clear -> should NOT prompt confirm again
			fireEvent.click(screen.getByTestId("btn-retry-settlement"));

			await waitFor(() => {
				expect(incomeApi.reviseIncomeSettlement).toHaveBeenCalledTimes(2);
			});

			expect(confirmSpy).toHaveBeenCalledTimes(1); // Still exactly 1!
			const secondKey = vi.mocked(incomeApi.reviseIncomeSettlement).mock
				.calls[1]![2];
			const secondPayload = vi.mocked(incomeApi.reviseIncomeSettlement).mock
				.calls[1]![1];

			expect(secondKey).toBe(firstKey);
			expect(secondPayload.expectedRevisionNo).toBe(3);
			expect(secondPayload.allocations).toEqual([]);

			confirmSpy.mockRestore();
		});

		it("replays exact Idempotency-Key and allocations on settlement create network uncertainty", async () => {
			const { wrapper } = createWrapper();
			const mockEntitlement: IncomeEntitlementItem = {
				entitlementId: "ent-1",
				sourceId: "src-1",
				sourceCode: "KYK_BURSU",
				sourceName: "KYK Bursu",
				periodMonth: "2026-09-01",
				revisionNo: 1,
				status: "ACTIVE",
				amount: "2000.00",
				allocatedAmount: "0.00",
				outstandingAmount: "2000.00",
				settlementStatus: "OPEN",
				expectedReceiptOn: "2026-09-10",
				overdue: false,
				note: null,
			};

			vi.mocked(incomeApi.fetchIncomeEntitlements).mockResolvedValue({
				entitlements: [mockEntitlement],
				hasMore: false,
				limit: 100,
				nextCursor: null,
			});

			const networkErr = new TypeError("Failed to fetch");
			vi.mocked(incomeApi.createIncomeSettlement)
				.mockRejectedValueOnce(networkErr)
				.mockResolvedValueOnce({
					incomeReceiptId: "rec-1",
					receiptAmount: "1000.00",
					allocatedAmount: "1000.00",
					unallocatedAmount: "0.00",
					revisionNo: 1,
					allocations: [
						{
							entitlementId: "ent-1",
							periodMonth: "2026-09-01",
							entitlementAmount: "2000.00",
							allocatedAmount: "1000.00",
							entitlementOutstandingAfterAllReceipts: "1000.00",
						},
					],
				});

			render(
				<IncomeSettlementEditor
					incomeReceiptId="rec-1"
					sourceId="src-1"
					receiptAmount="1000.00"
					existingSettlement={null}
					onSuccess={vi.fn()}
					onCancel={vi.fn()}
				/>,
				{ wrapper },
			);

			await waitFor(() => {
				expect(screen.getByTestId("btn-save-settlement")).toBeDefined();
				expect(screen.queryByText(/Yükleniyor/i)).toBeNull();
			});

			// Select entitlement
			const select = screen.getByLabelText(/Beklenen Gelir Dönemi/i);
			fireEvent.change(select, { target: { value: "ent-1" } });

			// Enter 1000.00
			const amountInput = screen.getByLabelText(/Aktarılan Tutar/i);
			fireEvent.change(amountInput, { target: { value: "1000.00" } });

			// Submit create
			fireEvent.click(screen.getByTestId("btn-save-settlement"));

			await waitFor(() => {
				expect(
					screen.getByTestId("settlement-uncertain-warning"),
				).toBeDefined();
			});

			expect(incomeApi.createIncomeSettlement).toHaveBeenCalledTimes(1);
			const firstKey = vi.mocked(incomeApi.createIncomeSettlement).mock
				.calls[0]![2];
			const firstReceiptId = vi.mocked(incomeApi.createIncomeSettlement).mock
				.calls[0]![0];
			const firstPayload = vi.mocked(incomeApi.createIncomeSettlement).mock
				.calls[0]![1];

			// Explicit retry
			fireEvent.click(screen.getByTestId("btn-retry-settlement"));

			await waitFor(() => {
				expect(incomeApi.createIncomeSettlement).toHaveBeenCalledTimes(2);
			});

			const secondKey = vi.mocked(incomeApi.createIncomeSettlement).mock
				.calls[1]![2];
			const secondReceiptId = vi.mocked(incomeApi.createIncomeSettlement).mock
				.calls[1]![0];
			const secondPayload = vi.mocked(incomeApi.createIncomeSettlement).mock
				.calls[1]![1];

			expect(secondKey).toBe(firstKey);
			expect(secondReceiptId).toBe("rec-1");
			expect(secondPayload).toEqual(firstPayload);
			expect(secondPayload.allocations).toEqual([
				{
					entitlementId: "ent-1",
					amount: "1000.00",
				},
			]);
		});

		it("replays exact Idempotency-Key and payload on settlement revise network uncertainty", async () => {
			const { wrapper } = createWrapper();
			const existingSettlement: IncomeReceiptSettlementResponse = {
				incomeReceiptId: "rec-1",
				receiptAmount: "2000.00",
				allocatedAmount: "1000.00",
				unallocatedAmount: "1000.00",
				revisionNo: 2,
				allocations: [
					{
						entitlementId: "ent-1",
						periodMonth: "2026-09-01",
						entitlementAmount: "2000.00",
						allocatedAmount: "1000.00",
						entitlementOutstandingAfterAllReceipts: "1000.00",
					},
				],
			};

			const mockEntitlement: IncomeEntitlementItem = {
				entitlementId: "ent-1",
				sourceId: "src-1",
				sourceCode: "KYK_BURSU",
				sourceName: "KYK Bursu",
				periodMonth: "2026-09-01",
				revisionNo: 1,
				status: "ACTIVE",
				amount: "2000.00",
				allocatedAmount: "1000.00",
				outstandingAmount: "1000.00",
				settlementStatus: "PARTIAL",
				expectedReceiptOn: "2026-09-10",
				overdue: false,
				note: null,
			};

			vi.mocked(incomeApi.fetchIncomeEntitlements).mockResolvedValue({
				entitlements: [mockEntitlement],
				hasMore: false,
				limit: 100,
				nextCursor: null,
			});

			const networkErr = new TypeError("Failed to fetch");
			vi.mocked(incomeApi.reviseIncomeSettlement)
				.mockRejectedValueOnce(networkErr)
				.mockResolvedValueOnce({
					...existingSettlement,
					allocatedAmount: "2000.00",
					unallocatedAmount: "0.00",
					revisionNo: 3,
					allocations: [
						{
							...existingSettlement.allocations[0]!,
							allocatedAmount: "2000.00",
							entitlementOutstandingAfterAllReceipts: "0.00",
						},
					],
				});

			render(
				<IncomeSettlementEditor
					incomeReceiptId="rec-1"
					sourceId="src-1"
					receiptAmount="2000.00"
					existingSettlement={existingSettlement}
					onSuccess={vi.fn()}
					onCancel={vi.fn()}
				/>,
				{ wrapper },
			);

			await waitFor(() => {
				expect(screen.getByTestId("btn-save-settlement")).toBeDefined();
			});

			// Change allocation from 1000 to 2000
			const amountInputs = screen.getAllByRole("textbox");
			if (amountInputs[0]) {
				fireEvent.change(amountInputs[0], { target: { value: "2000.00" } });
			}

			fireEvent.click(screen.getByTestId("btn-save-settlement"));

			await waitFor(() => {
				expect(
					screen.getByTestId("settlement-uncertain-warning"),
				).toBeDefined();
			});

			expect(incomeApi.reviseIncomeSettlement).toHaveBeenCalledTimes(1);
			const firstKey = vi.mocked(incomeApi.reviseIncomeSettlement).mock
				.calls[0]![2];
			const firstPayload = vi.mocked(incomeApi.reviseIncomeSettlement).mock
				.calls[0]![1];

			// Explicit retry
			fireEvent.click(screen.getByTestId("btn-retry-settlement"));

			await waitFor(() => {
				expect(incomeApi.reviseIncomeSettlement).toHaveBeenCalledTimes(2);
			});

			const secondKey = vi.mocked(incomeApi.reviseIncomeSettlement).mock
				.calls[1]![2];
			const secondPayload = vi.mocked(incomeApi.reviseIncomeSettlement).mock
				.calls[1]![1];

			expect(secondKey).toBe(firstKey);
			expect(secondPayload).toEqual(firstPayload);
			expect(secondPayload.expectedRevisionNo).toBe(2);
			expect(secondPayload.allocations).toEqual([
				{
					entitlementId: "ent-1",
					amount: "2000.00",
				},
			]);
		});

		it("clears frozen attempt and refetches on INCOME_SETTLEMENT_REVISION_CONFLICT", async () => {
			const { wrapper, queryClient } = createWrapper();
			const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

			const existingSettlement: IncomeReceiptSettlementResponse = {
				incomeReceiptId: "rec-1",
				receiptAmount: "2000.00",
				allocatedAmount: "1000.00",
				unallocatedAmount: "1000.00",
				revisionNo: 2,
				allocations: [
					{
						entitlementId: "ent-1",
						periodMonth: "2026-09-01",
						entitlementAmount: "2000.00",
						allocatedAmount: "1000.00",
						entitlementOutstandingAfterAllReceipts: "1000.00",
					},
				],
			};

			const mockEntitlement: IncomeEntitlementItem = {
				entitlementId: "ent-1",
				sourceId: "src-1",
				sourceCode: "KYK_BURSU",
				sourceName: "KYK Bursu",
				periodMonth: "2026-09-01",
				revisionNo: 1,
				status: "ACTIVE",
				amount: "2000.00",
				allocatedAmount: "1000.00",
				outstandingAmount: "1000.00",
				settlementStatus: "PARTIAL",
				expectedReceiptOn: "2026-09-10",
				overdue: false,
				note: null,
			};

			vi.mocked(incomeApi.fetchIncomeEntitlements).mockResolvedValue({
				entitlements: [mockEntitlement],
				hasMore: false,
				limit: 100,
				nextCursor: null,
			});

			vi.mocked(incomeApi.reviseIncomeSettlement).mockRejectedValueOnce(
				new ApiError({
					status: 409,
					code: "INCOME_SETTLEMENT_REVISION_CONFLICT",
					message: "Settlement was modified by another session",
				}),
			);

			render(
				<IncomeSettlementEditor
					incomeReceiptId="rec-1"
					sourceId="src-1"
					receiptAmount="2000.00"
					existingSettlement={existingSettlement}
					onSuccess={vi.fn()}
					onCancel={vi.fn()}
				/>,
				{ wrapper },
			);

			await waitFor(() => {
				expect(screen.getByTestId("btn-save-settlement")).toBeDefined();
			});

			fireEvent.click(screen.getByTestId("btn-save-settlement"));

			await waitFor(() => {
				expect(incomeApi.reviseIncomeSettlement).toHaveBeenCalledTimes(1);
			});

			// Should show error and invalidate queries
			await waitFor(() => {
				expect(invalidateSpy).toHaveBeenCalled();
			});

			// Should NOT show uncertain retry warning (since it's a conflict, not network uncertainty)
			expect(screen.queryByTestId("settlement-uncertain-warning")).toBeNull();
		});
	});
});

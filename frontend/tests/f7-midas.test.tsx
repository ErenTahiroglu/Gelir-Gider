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
import * as f7Api from "../src/api/f7-api";
import type {
	MidasBucketProductDto,
	MidasLiquidityProductDto,
} from "../src/api/f7-types";
import * as manualExpensesApi from "../src/api/manual-expenses-api";
import { GoalsPage } from "../src/components/goals/GoalsPage";
import { LongTermPage } from "../src/components/long-term/LongTermPage";
import { MidasPage } from "../src/components/midas/MidasPage";
import { MidasSetupCard } from "../src/components/midas/MidasSetupCard";
import { ReserveTransferModal } from "../src/components/midas/ReserveTransferModal";

vi.mock("../src/api/f7-api");
vi.mock("../src/api/manual-expenses-api");

// Mock tanstack router Link
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

const mockLiquidity: MidasLiquidityProductDto = {
	midasAccountId: "midas-acc-1",
	ledgerAccountId: "ledger-acc-midas",
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
};

const mockReserveBucket: MidasBucketProductDto = {
	bucketId: "b-card",
	code: "CARD_RES_1",
	name: "Garanti Bonus Rezervi",
	bucketType: "CREDIT_CARD_RESERVE",
	balance: "2500.00",
};

describe("Phase F7 — Midas Liquidity, Setup & Card Reserve", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it("Section 70: shows setup CTA when GET /midas/liquidity returns 404 MIDAS_ACCOUNT_NOT_FOUND, guards goals and long-term", async () => {
		const notFoundError = new ApiError({
			status: 404,
			code: "MIDAS_ACCOUNT_NOT_FOUND",
			message: "Midas account not found",
		});

		vi.spyOn(f7Api, "fetchMidasLiquidity").mockRejectedValue(notFoundError);
		vi.spyOn(f7Api, "fetchMidasTransfers").mockResolvedValue({
			transfers: [],
			nextCursor: null,
			limit: 50,
			hasMore: false,
		});
		vi.spyOn(manualExpensesApi, "fetchAllLedgerAccounts").mockResolvedValue([
			{
				accountId: "acc-1",
				code: "100.01",
				name: "Midas Yatırım Hesabı",
				accountType: "ASSET",
				normalBalance: "DEBIT",
				currency: "TRY",
				balance: "15000.00",
				archived: false,
			},
		]);

		const { wrapper: midasWrapper } = createWrapper();
		render(<MidasPage />, { wrapper: midasWrapper });

		// Assert setup CTA is shown, NOT generic fatal error
		expect(
			await screen.findByText(/Midas Likidite Hesabını Bağla/i),
		).toBeInTheDocument();
		expect(screen.queryByText(/Bilinmeyen bir hata oluştu/i)).toBeNull();

		cleanup();

		// Check that GoalsPage guards goal creation when Midas is not configured
		vi.spyOn(f7Api, "fetchShortTermGoals").mockResolvedValue({
			goals: [],
			nextCursor: null,
			limit: 50,
			hasMore: false,
		});
		const { wrapper: goalsWrapper } = createWrapper();
		render(<GoalsPage />, { wrapper: goalsWrapper });

		const goalsAlert = await screen.findByTestId("midas-not-configured-alert");
		expect(goalsAlert).toHaveTextContent(/Midas likidite hesabını bağlayın/i);

		cleanup();

		// Check that LongTermPage guards task creation when Midas is not configured
		vi.spyOn(f7Api, "fetchLongTermTasks").mockResolvedValue({
			tasks: [],
			nextCursor: null,
			limit: 50,
			hasMore: false,
		});
		const { wrapper: longTermWrapper } = createWrapper();
		render(<LongTermPage />, { wrapper: longTermWrapper });

		const longTermAlert = await screen.findByTestId(
			"midas-not-configured-alert",
		);
		expect(longTermAlert).toHaveTextContent(
			/Midas likidite hesabını bağlayın/i,
		);
	});

	it("Section 71: performs Midas setup with eligible ASSET account without Idempotency-Key and refetches liquidity", async () => {
		const mockSetup = vi.spyOn(f7Api, "setupMidasAccount").mockResolvedValue({
			midasAccount: {
				midasAccountId: "midas-new",
				ledgerAccountId: "acc-1",
				createdAt: "2026-03-29T10:00:00Z",
			},
		});

		vi.spyOn(manualExpensesApi, "fetchAllLedgerAccounts").mockResolvedValue([
			{
				accountId: "acc-1",
				code: "100.01",
				name: "Midas TRY Hesabı",
				accountType: "ASSET",
				normalBalance: "DEBIT",
				currency: "TRY",
				balance: "10000.00",
				archived: false,
			},
			{
				accountId: "acc-liability",
				code: "300.01",
				name: "Kredi Kartı Borcu",
				accountType: "LIABILITY",
				normalBalance: "CREDIT",
				currency: "TRY",
				balance: "2000.00",
				archived: false,
			},
		]);

		const onSetupSuccess = vi.fn();
		const { wrapper } = createWrapper();
		render(<MidasSetupCard onSetupSuccess={onSetupSuccess} />, { wrapper });

		await waitFor(() => {
			expect(
				screen.getByLabelText(/Bağlanacak Kasa \/ Banka Hesabı/i),
			).toBeInTheDocument();
		});

		// Only eligible ASSET accounts in TRY should appear in dropdown
		const select = screen.getByLabelText(/Bağlanacak Kasa \/ Banka Hesabı/i);
		expect(screen.getByText(/Midas TRY Hesabı/i)).toBeInTheDocument();
		expect(screen.queryByText(/Kredi Kartı Borcu/i)).toBeNull();

		fireEvent.change(select, { target: { value: "acc-1" } });
		fireEvent.click(screen.getByTestId("midas-setup-submit-btn"));

		await waitFor(() => {
			expect(mockSetup).toHaveBeenCalledWith("acc-1");
			expect(onSetupSuccess).toHaveBeenCalled();
		});
	});

	it("Section 72: handles setup network uncertainty by refetching liquidity first", async () => {
		// Setup throws uncertain network error (e.g. status 0 or network failure)
		vi.spyOn(f7Api, "setupMidasAccount").mockRejectedValue(
			new ApiError({
				status: 0,
				code: "NETWORK_ERROR",
				message: "Ağ hatası",
			}),
		);

		// Liquidity refetch succeeds and returns account matching acc-1
		const mockFetchLiquidity = vi
			.spyOn(f7Api, "fetchMidasLiquidity")
			.mockResolvedValue({
				liquidity: {
					...mockLiquidity,
					ledgerAccountId: "acc-1",
				},
			});

		vi.spyOn(manualExpensesApi, "fetchAllLedgerAccounts").mockResolvedValue([
			{
				accountId: "acc-1",
				code: "100.01",
				name: "Midas TRY",
				accountType: "ASSET",
				normalBalance: "DEBIT",
				currency: "TRY",
				balance: "10000.00",
				archived: false,
			},
		]);

		const onSetupSuccess = vi.fn();
		const { wrapper } = createWrapper();
		render(<MidasSetupCard onSetupSuccess={onSetupSuccess} />, { wrapper });

		await waitFor(() => {
			expect(
				screen.getByLabelText(/Bağlanacak Kasa \/ Banka Hesabı/i),
			).toBeInTheDocument();
		});

		fireEvent.change(
			screen.getByLabelText(/Bağlanacak Kasa \/ Banka Hesabı/i),
			{
				target: { value: "acc-1" },
			},
		);
		fireEvent.click(screen.getByTestId("midas-setup-submit-btn"));

		// Verification: refetch liquidity was called to confirm whether the account was linked
		await waitFor(() => {
			expect(mockFetchLiquidity).toHaveBeenCalled();
			expect(onSetupSuccess).toHaveBeenCalled();
		});
	});

	it("Section 73: renders authoritative liquidity balances directly from server DTO (₺10.000,00 / ₺6.500,00 / ₺3.500,00)", async () => {
		vi.spyOn(f7Api, "fetchMidasLiquidity").mockResolvedValue({
			liquidity: {
				...mockLiquidity,
				physicalBalance: "10000.00",
				totalEarmarked: "6500.00",
				unallocatedBalance: "3500.00",
			},
		});
		vi.spyOn(f7Api, "fetchMidasTransfers").mockResolvedValue({
			transfers: [],
			nextCursor: null,
			limit: 50,
			hasMore: false,
		});

		const { wrapper } = createWrapper();
		render(<MidasPage />, { wrapper });

		// Assert server authority values are displayed formatted in Turkish Lira
		expect(await screen.findByText("₺10.000,00")).toBeInTheDocument();
		expect(screen.getByText("₺6.500,00")).toBeInTheDocument();
		expect(screen.getByText("₺3.500,00")).toBeInTheDocument();
	});

	it("Section 80: card reserve allocate and release enforce BigInt bounds and invalidate statement queries", async () => {
		const mockTransfer = vi
			.spyOn(f7Api, "createMidasTransfer")
			.mockResolvedValue({
				transfer: {
					transferId: "tr-1",
					midasAccountId: "midas-acc-1",
					amount: "500.00",
					fromBucketId: null,
					toBucketId: "b-card",
					occurredAt: "2026-03-29T10:00:00Z",
				},
			});

		const { queryClient, wrapper } = createWrapper();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		// Test Allocate mode
		const { rerender } = render(
			<ReserveTransferModal
				isOpen={true}
				mode="allocate"
				reserveBucket={mockReserveBucket}
				midasAccountId="midas-acc-1"
				unallocatedBalance="3500.00"
				onClose={vi.fn()}
			/>,
			{ wrapper },
		);

		// Form displays available unallocated limit (₺3.500,00)
		expect(screen.getByTestId("reserve-unallocated-balance")).toHaveTextContent(
			"₺3.500,00",
		);

		// Fill amount: 500,00
		const input = screen.getByLabelText(/Eklenecek Tutar/i);
		fireEvent.change(input, { target: { value: "500,00" } });
		fireEvent.click(screen.getByRole("button", { name: /Rezervi Artır/i }));

		await waitFor(() => {
			expect(mockTransfer).toHaveBeenCalledWith(
				expect.objectContaining({
					midasAccountId: "midas-acc-1",
					fromBucketId: null,
					toBucketId: "b-card",
					amount: "500.00",
				}),
				expect.any(String), // Idempotency-Key
			);
		});

		// Verify card statements, active credit cards, liquidity and transfers were invalidated
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["card-statements"],
		});
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["active-credit-cards"],
		});
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["midas-liquidity"],
		});
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["midas-transfers"],
		});

		// Test Release mode
		rerender(
			<ReserveTransferModal
				isOpen={true}
				mode="release"
				reserveBucket={mockReserveBucket}
				midasAccountId="midas-acc-1"
				unallocatedBalance="3500.00"
				onClose={vi.fn()}
			/>,
		);

		// Form displays available reserve balance limit (₺2.500,00)
		expect(screen.getByTestId("reserve-current-balance")).toHaveTextContent(
			"₺2.500,00",
		);

		fireEvent.change(screen.getByLabelText(/Çekilecek Tutar/i), {
			target: { value: "300,00" },
		});
		fireEvent.click(screen.getByRole("button", { name: /Serbeste Aktar/i }));

		await waitFor(() => {
			expect(mockTransfer).toHaveBeenCalledWith(
				expect.objectContaining({
					midasAccountId: "midas-acc-1",
					fromBucketId: "b-card",
					toBucketId: null,
					amount: "300.00",
				}),
				expect.any(String),
			);
		});
	});
});

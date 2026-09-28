import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dashboardApi from "../src/api/dashboard-api";
import type { CreditCardsListResponse } from "../src/api/dashboard-types";
import { CreditCardSummary } from "../src/components/dashboard/CreditCardSummary";
import { SummaryMetrics } from "../src/components/dashboard/SummaryMetrics";
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

describe("Dashboard Credit Cards — Aggregate Balances & Active Card List", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.spyOn(istanbulDate, "getIstanbulPeriodMonth").mockReturnValue("2026-09");
		vi.spyOn(dashboardApi, "fetchSpendingSummary").mockResolvedValue({
			periodMonth: "2026-09",
			totalPersonalSpending: "0.00",
			categories: [],
			unclassifiedAmount: "0.00",
		});
		vi.spyOn(dashboardApi, "fetchOpenCreditCardStatements").mockResolvedValue({
			statements: [],
			limit: 100,
			hasMore: false,
			nextCursor: null,
		});
	});

	it("sums liveLiabilityBalance of all active cards using exact bigint cents", async () => {
		const cardsResponse: CreditCardsListResponse = {
			cards: [
				{
					cardId: "card-1",
					userId: "user-1",
					code: "ykb-main",
					status: "ACTIVE",
					revisionNo: 1,
					displayName: "Yapı Kredi",
					issuer: "Yapı Kredi",
					statementDay: 15,
					dueDay: 25,
					creditLimit: "50000.00",
					lastFour: "1234",
					note: null,
					createdAt: "2026-01-01T00:00:00Z",
					liveLiabilityBalance: "4500.50",
				},
				{
					cardId: "card-2",
					userId: "user-1",
					code: "akb-main",
					status: "ACTIVE",
					revisionNo: 1,
					displayName: "Akbank",
					issuer: "Akbank",
					statementDay: 10,
					dueDay: 20,
					creditLimit: "40000.00",
					lastFour: "5678",
					note: null,
					createdAt: "2026-01-01T00:00:00Z",
					liveLiabilityBalance: "1500.50",
				},
			],
			limit: 100,
			hasMore: false,
			nextCursor: null,
		};

		const fetchSpy = vi
			.spyOn(dashboardApi, "fetchActiveCreditCards")
			.mockResolvedValue(cardsResponse);

		renderWithQuery(<SummaryMetrics isUnlocked={true} />);

		// 4500.50 + 1500.50 = 6001.00 -> ₺6.001,00
		expect(await screen.findByText("₺6.001,00")).toBeInTheDocument();
		expect(fetchSpy).toHaveBeenCalledWith(100);
		expect(screen.getByText("2 aktif kart toplamı")).toBeInTheDocument();
	});

	it("fails aggregate metric closed when hasMore is true (does not calculate partial total)", async () => {
		const truncatedCardsResponse: CreditCardsListResponse = {
			cards: [
				{
					cardId: "card-1",
					userId: "user-1",
					code: "card-1",
					status: "ACTIVE",
					revisionNo: 1,
					displayName: "Kart 1",
					issuer: "Banka",
					statementDay: 1,
					dueDay: 10,
					creditLimit: null,
					lastFour: null,
					note: null,
					createdAt: "2026-01-01T00:00:00Z",
					liveLiabilityBalance: "1000.00",
				},
			],
			limit: 100,
			hasMore: true, // truncated page!
			nextCursor: "cursor-123",
		};

		vi.spyOn(dashboardApi, "fetchActiveCreditCards").mockResolvedValue(
			truncatedCardsResponse,
		);

		renderWithQuery(<SummaryMetrics isUnlocked={true} />);

		expect(
			await screen.findByText("Kart sayısı limiti aşıldı"),
		).toBeInTheDocument();
		const cardMetric = screen.getByTestId("metric-kartlarda-bu-donem");
		expect(cardMetric).toHaveTextContent("—");
		expect(cardMetric).not.toHaveTextContent("₺1.000,00");
	});

	it("renders CreditCardSummary list with compact rows", async () => {
		const cardsResponse: CreditCardsListResponse = {
			cards: [
				{
					cardId: "card-1",
					userId: "user-1",
					code: "ykb-main",
					status: "ACTIVE",
					revisionNo: 1,
					displayName: "Yapı Kredi World",
					issuer: "Yapı Kredi",
					statementDay: 15,
					dueDay: 25,
					creditLimit: "50000.00",
					lastFour: "1234",
					note: null,
					createdAt: "2026-01-01T00:00:00Z",
					liveLiabilityBalance: "4500.50",
				},
			],
			limit: 100,
			hasMore: false,
			nextCursor: null,
		};

		vi.spyOn(dashboardApi, "fetchActiveCreditCards").mockResolvedValue(
			cardsResponse,
		);

		renderWithQuery(<CreditCardSummary isUnlocked={true} />);

		expect(await screen.findByText("Yapı Kredi World")).toBeInTheDocument();
		expect(screen.getByText("Yapı Kredi •••• 1234")).toBeInTheDocument();
		expect(screen.getByText("₺4.500,50")).toBeInTheDocument();
	});

	it("renders empty state in CreditCardSummary when no cards exist", async () => {
		vi.spyOn(dashboardApi, "fetchActiveCreditCards").mockResolvedValue({
			cards: [],
			limit: 100,
			hasMore: false,
			nextCursor: null,
		});

		renderWithQuery(<CreditCardSummary isUnlocked={true} />);

		expect(
			await screen.findByText("Kayıtlı aktif kredi kartı bulunmuyor."),
		).toBeInTheDocument();
	});
});

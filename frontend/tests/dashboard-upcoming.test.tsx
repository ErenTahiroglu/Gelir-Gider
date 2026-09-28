import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dashboardApi from "../src/api/dashboard-api";
import type { CreditCardsListResponse } from "../src/api/dashboard-types";
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

describe("Dashboard Upcoming Payment — Authoritative Earliest OPEN Statement", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.spyOn(istanbulDate, "getIstanbulPeriodMonth").mockReturnValue("2026-09");
		vi.spyOn(dashboardApi, "fetchSpendingSummary").mockResolvedValue({
			periodMonth: "2026-09",
			totalPersonalSpending: "0.00",
			categories: [],
			unclassifiedAmount: "0.00",
		});
	});

	it("picks earliest dueDate among OPEN statements across multiple cards", async () => {
		const cardsResponse: CreditCardsListResponse = {
			cards: [
				{
					cardId: "card-1",
					userId: "user-1",
					code: "c1",
					status: "ACTIVE",
					revisionNo: 1,
					displayName: "Card 1",
					issuer: "Bank 1",
					statementDay: 1,
					dueDay: 20,
					creditLimit: null,
					lastFour: null,
					note: null,
					createdAt: "2026-01-01T00:00:00Z",
					liveLiabilityBalance: "100.00",
				},
				{
					cardId: "card-2",
					userId: "user-1",
					code: "c2",
					status: "ACTIVE",
					revisionNo: 1,
					displayName: "Card 2",
					issuer: "Bank 2",
					statementDay: 1,
					dueDay: 18,
					creditLimit: null,
					lastFour: null,
					note: null,
					createdAt: "2026-01-01T00:00:00Z",
					liveLiabilityBalance: "200.00",
				},
			],
			limit: 100,
			hasMore: false,
			nextCursor: null,
		};

		vi.spyOn(dashboardApi, "fetchActiveCreditCards").mockResolvedValue(
			cardsResponse,
		);

		vi.spyOn(dashboardApi, "fetchOpenCreditCardStatements").mockImplementation(
			async (cardId) => {
				if (cardId === "card-1") {
					return {
						statements: [
							{
								statementId: "s1",
								cardId: "card-1",
								userId: "user-1",
								cycleYear: 2026,
								cycleMonth: 9,
								status: "OPEN",
								revisionNo: 1,
								statementAmount: "3500.00",
								statementDate: "2026-09-01",
								dueDate: "2026-09-25", // Later
								note: null,
							},
						],
						limit: 100,
						hasMore: false,
						nextCursor: null,
					};
				}
				return {
					statements: [
						{
							statementId: "s2",
							cardId: "card-2",
							userId: "user-1",
							cycleYear: 2026,
							cycleMonth: 9,
							status: "OPEN",
							revisionNo: 1,
							statementAmount: "1250.50",
							statementDate: "2026-09-01",
							dueDate: "2026-09-18", // Earliest!
							note: null,
						},
					],
					limit: 100,
					hasMore: false,
					nextCursor: null,
				};
			},
		);

		renderWithQuery(<SummaryMetrics isUnlocked={true} />);

		// Expect earliest: 1250.50 with dueDate 2026-09-18
		expect(await screen.findByText("₺1.250,50")).toBeInTheDocument();
		expect(screen.queryByText("₺3.500,00")).not.toBeInTheDocument();
	});

	it("renders 'Yaklaşan ödeme yok' when no OPEN statements exist", async () => {
		const cardsResponse: CreditCardsListResponse = {
			cards: [
				{
					cardId: "card-1",
					userId: "user-1",
					code: "c1",
					status: "ACTIVE",
					revisionNo: 1,
					displayName: "Card 1",
					issuer: "Bank",
					statementDay: 1,
					dueDay: 20,
					creditLimit: null,
					lastFour: null,
					note: null,
					createdAt: "2026-01-01T00:00:00Z",
					liveLiabilityBalance: "0.00",
				},
			],
			limit: 100,
			hasMore: false,
			nextCursor: null,
		};

		vi.spyOn(dashboardApi, "fetchActiveCreditCards").mockResolvedValue(
			cardsResponse,
		);
		vi.spyOn(dashboardApi, "fetchOpenCreditCardStatements").mockResolvedValue({
			statements: [],
			limit: 100,
			hasMore: false,
			nextCursor: null,
		});

		renderWithQuery(<SummaryMetrics isUnlocked={true} />);

		expect(await screen.findByText("Yaklaşan ödeme yok")).toBeInTheDocument();
		const upcomingCard = screen.getByTestId("metric-yaklasan-odeme");
		expect(upcomingCard).not.toHaveTextContent("₺0,00");
	});

	it("fails closed when statement fetch indicates hasMore: true", async () => {
		const cardsResponse: CreditCardsListResponse = {
			cards: [
				{
					cardId: "card-1",
					userId: "user-1",
					code: "c1",
					status: "ACTIVE",
					revisionNo: 1,
					displayName: "Card 1",
					issuer: "Bank",
					statementDay: 1,
					dueDay: 20,
					creditLimit: null,
					lastFour: null,
					note: null,
					createdAt: "2026-01-01T00:00:00Z",
					liveLiabilityBalance: "500.00",
				},
			],
			limit: 100,
			hasMore: false,
			nextCursor: null,
		};

		vi.spyOn(dashboardApi, "fetchActiveCreditCards").mockResolvedValue(
			cardsResponse,
		);
		vi.spyOn(dashboardApi, "fetchOpenCreditCardStatements").mockResolvedValue({
			statements: [
				{
					statementId: "s1",
					cardId: "card-1",
					userId: "user-1",
					cycleYear: 2026,
					cycleMonth: 9,
					status: "OPEN",
					revisionNo: 1,
					statementAmount: "500.00",
					statementDate: "2026-09-01",
					dueDate: "2026-09-20",
					note: null,
				},
			],
			limit: 100,
			hasMore: true, // Truncated statement results!
			nextCursor: "cursor-1",
		});

		renderWithQuery(<SummaryMetrics isUnlocked={true} />);

		expect(
			await screen.findByText("Ödeme bilgisi alınamadı"),
		).toBeInTheDocument();
		const upcomingCard = screen.getByTestId("metric-yaklasan-odeme");
		expect(upcomingCard).not.toHaveTextContent("₺500,00");
	});
});

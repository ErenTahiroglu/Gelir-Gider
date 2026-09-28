import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dashboardApi from "../src/api/dashboard-api";
import type { SpendingSummaryResponse } from "../src/api/dashboard-types";
import { ApiError } from "../src/api/errors";
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

describe("Dashboard Spending Summary — Bu Ay Harcanan Authoritative Read", () => {
	const periodMonth = "2026-09";

	beforeEach(() => {
		vi.restoreAllMocks();
		vi.spyOn(istanbulDate, "getIstanbulPeriodMonth").mockReturnValue(
			periodMonth,
		);
		// Stub credit cards & statements to return empty arrays to isolate spending metric
		vi.spyOn(dashboardApi, "fetchActiveCreditCards").mockResolvedValue({
			cards: [],
			limit: 100,
			hasMore: false,
			nextCursor: null,
		});
	});

	it("renders exact totalPersonalSpending from /spending/summary endpoint", async () => {
		const spendingSummary: SpendingSummaryResponse = {
			periodMonth,
			totalPersonalSpending: "4850.75",
			categories: [
				{
					categoryId: "cat-1",
					categoryName: "Market",
					amount: "3000.00",
					transactionCount: 5,
				},
			],
			unclassifiedAmount: "1850.75",
		};

		const spy = vi
			.spyOn(dashboardApi, "fetchSpendingSummary")
			.mockResolvedValue(spendingSummary);

		renderWithQuery(<SummaryMetrics isUnlocked={true} />);

		expect(await screen.findByText("₺4.850,75")).toBeInTheDocument();
		expect(spy).toHaveBeenCalledWith(periodMonth);
		expect(screen.getByText("Doğrulanmış kişisel harcama")).toBeInTheDocument();
	});

	it("fails closed without fallback to 0 TL when /spending/summary fails", async () => {
		vi.spyOn(dashboardApi, "fetchSpendingSummary").mockRejectedValue(
			new ApiError({
				status: 500,
				code: "INTERNAL_ERROR",
				message: "Unresolved split conflict",
			}),
		);

		renderWithQuery(<SummaryMetrics isUnlocked={true} />);

		expect(
			await screen.findByText("Harcama özeti doğrulanamadı"),
		).toBeInTheDocument();
		const metricCard = screen.getByTestId("metric-bu-ay-harcanan");
		expect(metricCard).toHaveTextContent("—");

		// STRICT REQUIREMENT: Absolutely no fallback to 0,00 ₺ or 0 TL
		expect(metricCard).not.toHaveTextContent("₺0,00");
		expect(metricCard).not.toHaveTextContent("0 TL");
		expect(metricCard).not.toHaveTextContent("0,00");
	});
});

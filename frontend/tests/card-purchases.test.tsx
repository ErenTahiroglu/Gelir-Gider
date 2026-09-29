import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as creditCardsApi from "../src/api/credit-cards-api";
import { PurchaseList } from "../src/components/cards/purchases/PurchaseList";

vi.mock("../src/api/credit-cards-api");

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

describe("F5 Card Purchases — List, Gross vs Personal & Void Invariants", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders authoritative gross vs personal vs external amounts without client recalculation", async () => {
		const purchases: creditCardsApi.CreditCardPurchaseItem[] = [
			{
				purchaseId: "pur-shared-1",
				cardId: "card-1",
				status: "POSTED",
				revisionNo: 1,
				amount: "900.00",
				personalExpenseAmount: "300.00",
				externalReceivableAmount: "600.00",
				purchaseCategory: "RESTAURANT",
				merchant: "Akdeniz Restoran",
				description: "Akşam yemeği",
				installmentCount: 1,
				split: {
					splitId: "split-1",
					status: "ACTIVE",
					userShareAmount: "300.00",
					externalShareAmount: "600.00",
					splitMethod: "EQUAL",
					participantCount: 2,
				},
				purchaseDate: "2026-03-29",
				occurredAt: "2026-03-29T12:00:00Z",
			},
			{
				purchaseId: "pur-unshared-2",
				cardId: "card-1",
				status: "POSTED",
				revisionNo: 1,
				amount: "450.00",
				personalExpenseAmount: "450.00",
				externalReceivableAmount: "0.00",
				purchaseCategory: "MARKET",
				merchant: "Migros",
				description: "Haftalık market",
				installmentCount: 3,
				split: null,
				purchaseDate: "2026-03-28",
				occurredAt: "2026-03-28T10:00:00Z",
			},
		];

		vi.spyOn(creditCardsApi, "fetchCreditCardPurchases").mockResolvedValue({
			purchases: purchases,
			nextCursor: null,
		});

		await renderWithRouter(<PurchaseList cardId="card-1" />);

		await waitFor(() => {
			expect(screen.getByText("Akdeniz Restoran")).toBeInTheDocument();
		});

		// Authoritative gross amount
		expect(screen.getByText("₺900,00")).toBeInTheDocument();
		// Authoritative personal share
		expect(screen.getByTestId("purchase-personal-share")).toHaveTextContent(
			"₺300,00",
		);
		// Authoritative external receivable
		expect(
			screen.getByTestId("purchase-external-receivable"),
		).toHaveTextContent("₺600,00");

		// Unshared purchase with installments
		expect(screen.getByText("Migros")).toBeInTheDocument();
		expect(screen.getByText("₺450,00")).toBeInTheDocument();
		expect(screen.getByText(/3 Taksit/i)).toBeInTheDocument();
	});

	it("keeps VOID purchase visible in history with distinct status badge", async () => {
		const purchases: creditCardsApi.CreditCardPurchaseItem[] = [
			{
				purchaseId: "pur-voided",
				cardId: "card-1",
				status: "VOID",
				revisionNo: 2,
				amount: "750.00",
				personalExpenseAmount: "750.00",
				externalReceivableAmount: "0.00",
				purchaseCategory: "ELECTRONICS",
				merchant: "Teknosa",
				description: "Kulaklık (iade edildi)",
				installmentCount: 1,
				split: null,
				purchaseDate: "2026-03-20",
				occurredAt: "2026-03-20T14:00:00Z",
			},
		];

		vi.spyOn(creditCardsApi, "fetchCreditCardPurchases").mockResolvedValue({
			purchases: purchases,
			nextCursor: null,
		});

		await renderWithRouter(<PurchaseList cardId="card-1" />);

		await waitFor(() => {
			expect(screen.getByText("Teknosa")).toBeInTheDocument();
		});

		// Must show VOID badge and must not be deleted from UI
		expect(screen.getByText("İptal Edildi")).toBeInTheDocument();
		expect(screen.getByText("₺750,00")).toBeInTheDocument();
	});
});

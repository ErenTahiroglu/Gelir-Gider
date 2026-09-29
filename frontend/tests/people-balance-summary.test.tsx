import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as peopleApi from "../src/api/people-api";
import type {
	PersonBalanceSummaryDto,
	PersonProductDto,
} from "../src/api/people-types";
import { PersonDetailPage } from "../src/components/people/PersonDetailPage";

vi.mock("../src/api/people-api");

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
		history: createMemoryHistory({ initialEntries: ["/people/p1"] }),
	});
	await router.load();

	return render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
}

describe("F6 Person Balance Summary — FRIEND 5-TL Rule, FAMILY Exact & Distinct Balances", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders exact backend collectionTarget for FRIEND without local calculation", async () => {
		const friendPerson: PersonProductDto = {
			personId: "p-friend",
			status: "ACTIVE",
			displayName: "Ali",
			relationship: "FRIEND",
			note: null,
			revisionNo: 1,
			receivableBalance: "42.10",
			payableBalance: "0.00",
		};

		// Authoritative backend DTO per Section 5 & 69
		const balanceSummary: PersonBalanceSummaryDto = {
			personId: "p-friend",
			displayName: "Ali",
			relationship: "FRIEND",
			exactReceivableBalance: "42.10",
			exactPayableBalance: "0.00",
			collectionTarget: "45.00",
		};

		vi.spyOn(peopleApi, "fetchPerson").mockResolvedValue({
			person: friendPerson,
		});
		vi.spyOn(peopleApi, "fetchPersonBalanceSummary").mockResolvedValue(
			balanceSummary,
		);
		vi.spyOn(peopleApi, "fetchPersonObligations").mockResolvedValue({
			obligations: [],
			limit: 50,
			hasMore: false,
			nextCursor: null,
		});

		await renderWithRouter(<PersonDetailPage personId="p-friend" />);

		await waitFor(() => {
			expect(
				screen.getByTestId("summary-collection-target"),
			).toBeInTheDocument();
		});

		// Assert Önerilen Tahsilat uses exact backend collectionTarget (₺45,00)
		expect(screen.getByTestId("summary-collection-target")).toHaveTextContent(
			"₺45,00",
		);

		// Assert Gerçek Alacak uses exactReceivableBalance (₺42,10)
		expect(screen.getByTestId("summary-exact-receivable")).toHaveTextContent(
			"₺42,10",
		);
	});

	it("renders exact amount for FAMILY without inventing a 5-TL rounded target", async () => {
		const familyPerson: PersonProductDto = {
			personId: "p-family",
			status: "ACTIVE",
			displayName: "Ayşe Teyze",
			relationship: "FAMILY",
			note: null,
			revisionNo: 1,
			receivableBalance: "42.10",
			payableBalance: "0.00",
		};

		const familySummary: PersonBalanceSummaryDto = {
			personId: "p-family",
			displayName: "Ayşe Teyze",
			relationship: "FAMILY",
			exactReceivableBalance: "42.10",
			exactPayableBalance: "0.00",
		};

		vi.spyOn(peopleApi, "fetchPerson").mockResolvedValue({
			person: familyPerson,
		});
		vi.spyOn(peopleApi, "fetchPersonBalanceSummary").mockResolvedValue(
			familySummary,
		);
		vi.spyOn(peopleApi, "fetchPersonObligations").mockResolvedValue({
			obligations: [],
			limit: 50,
			hasMore: false,
			nextCursor: null,
		});

		await renderWithRouter(<PersonDetailPage personId="p-family" />);

		await waitFor(() => {
			expect(
				screen.getByTestId("summary-exact-receivable"),
			).toBeInTheDocument();
		});

		// Assert exact receivable rendered directly
		expect(screen.getByTestId("summary-exact-receivable")).toHaveTextContent(
			"₺42,10",
		);

		// Assert NO collection target was fabricated
		expect(
			screen.queryByTestId("summary-collection-target"),
		).not.toBeInTheDocument();
		expect(screen.queryByText("₺45,00")).not.toBeInTheDocument();
	});

	it("renders exact amount for OTHER without inventing a 5-TL rounded target", async () => {
		const otherPerson: PersonProductDto = {
			personId: "p-other",
			status: "ACTIVE",
			displayName: "Usta",
			relationship: "OTHER",
			note: null,
			revisionNo: 1,
			receivableBalance: "18.30",
			payableBalance: "50.00",
		};

		const otherSummary: PersonBalanceSummaryDto = {
			personId: "p-other",
			displayName: "Usta",
			relationship: "OTHER",
			exactReceivableBalance: "18.30",
			exactPayableBalance: "50.00",
		};

		vi.spyOn(peopleApi, "fetchPerson").mockResolvedValue({
			person: otherPerson,
		});
		vi.spyOn(peopleApi, "fetchPersonBalanceSummary").mockResolvedValue(
			otherSummary,
		);
		vi.spyOn(peopleApi, "fetchPersonObligations").mockResolvedValue({
			obligations: [],
			limit: 50,
			hasMore: false,
			nextCursor: null,
		});

		await renderWithRouter(<PersonDetailPage personId="p-other" />);

		await waitFor(() => {
			expect(
				screen.getByTestId("summary-exact-receivable"),
			).toBeInTheDocument();
		});

		// Exact receivable
		expect(screen.getByTestId("summary-exact-receivable")).toHaveTextContent(
			"₺18,30",
		);
		expect(
			screen.queryByTestId("summary-collection-target"),
		).not.toBeInTheDocument();
		expect(screen.queryByText("₺20,00")).not.toBeInTheDocument();

		// Exact payable
		expect(screen.getByTestId("summary-exact-payable")).toHaveTextContent(
			"₺50,00",
		);

		// Assert distinct cards and NO fake net balance (e.g. 50.00 - 18.30 = 31.70)
		expect(screen.getByTestId("receivable-balance-card")).toBeInTheDocument();
		expect(screen.getByTestId("payable-balance-card")).toBeInTheDocument();
		expect(screen.queryByText("₺31,70")).not.toBeInTheDocument();
	});

	it("disables Settle Receivables button when exactReceivableBalance is zero", async () => {
		const zeroPerson: PersonProductDto = {
			personId: "p-zero",
			status: "ACTIVE",
			displayName: "Burak",
			relationship: "FRIEND",
			note: null,
			revisionNo: 1,
			receivableBalance: "0.00",
			payableBalance: "200.00",
		};

		const zeroSummary: PersonBalanceSummaryDto = {
			personId: "p-zero",
			displayName: "Burak",
			relationship: "FRIEND",
			exactReceivableBalance: "0.00",
			exactPayableBalance: "200.00",
		};

		vi.spyOn(peopleApi, "fetchPerson").mockResolvedValue({
			person: zeroPerson,
		});
		vi.spyOn(peopleApi, "fetchPersonBalanceSummary").mockResolvedValue(
			zeroSummary,
		);
		vi.spyOn(peopleApi, "fetchPersonObligations").mockResolvedValue({
			obligations: [],
			limit: 50,
			hasMore: false,
			nextCursor: null,
		});

		await renderWithRouter(<PersonDetailPage personId="p-zero" />);

		await waitFor(() => {
			expect(
				screen.getByTestId("settle-receivables-action-btn"),
			).toBeInTheDocument();
		});

		// Button should be disabled
		expect(screen.getByTestId("settle-receivables-action-btn")).toHaveClass(
			"disabled",
		);
		expect(screen.getByTestId("settle-receivables-action-btn")).toHaveAttribute(
			"aria-disabled",
			"true",
		);
	});
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as creditCardsApi from "../src/api/credit-cards-api";
import * as manualExpensesApi from "../src/api/manual-expenses-api";
import { PurchaseDetailPage } from "../src/components/cards/purchases/PurchaseDetailPage";
import { SharedPurchaseForm } from "../src/components/cards/purchases/SharedPurchaseForm";

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

async function renderWithRouter(ui: React.ReactElement) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});

	const rootRoute = createRootRoute();
	const indexRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () => ui,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([indexRoute]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	await router.load();

	return render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
}

describe("F5 Shared Purchases & Splits Lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(creditCardsApi, "fetchCreditCard").mockResolvedValue({
			card: {
				cardId: "card-1",
				code: "BONUS",
				status: "ACTIVE",
				revisionNo: 1,
				displayName: "Garanti Bonus",
				issuer: "Garanti",
				statementDay: 15,
				dueDay: 25,
				creditLimit: "50000.00",
				lastFour: "1234",
				note: null,
				createdAt: "2026-03-29T10:00:00Z",
			},
		});
	});

	it("disables shared purchase creation and displays notice when no active people exist", async () => {
		vi.spyOn(creditCardsApi, "fetchAllActivePeople").mockResolvedValue([]);
		vi.spyOn(manualExpensesApi, "fetchSpendingCategories").mockResolvedValue({
			categories: [],
		});

		render(<SharedPurchaseForm cardId="card-1" />, {
			wrapper: createWrapper(),
		});

		await waitFor(() => {
			expect(
				screen.getByText(
					/Ortak harcama için önce en az bir kişi kaydı gerekiyor/i,
				),
			).toBeInTheDocument();
		});

		expect(
			screen.queryByTestId("submit-shared-purchase-button"),
		).not.toBeInTheDocument();
	});

	it("submits atomic shared purchase for EQUAL split without sending shareAmount, weight, or userWeight", async () => {
		vi.spyOn(creditCardsApi, "fetchAllActivePeople").mockResolvedValue([
			{ personId: "p-ali", displayName: "Ali Veli", relationship: "FRIEND" },
			{ personId: "p-ayse", displayName: "Ayşe Kaya", relationship: "FAMILY" },
		]);
		vi.spyOn(manualExpensesApi, "fetchSpendingCategories").mockResolvedValue({
			categories: [],
		});

		const mockSharedCreate = vi
			.spyOn(creditCardsApi, "createSharedCreditCardPurchase")
			.mockResolvedValue({
				purchase: {
					purchaseId: "pur-shared-1",
					cardId: "card-1",
					status: "POSTED",
					revisionNo: 1,
					amount: "300.00",
					personalExpenseAmount: "100.00",
					externalReceivableAmount: "200.00",
					purchaseCategory: "RESTAURANT",
					merchant: "Lokanta",
					description: "Yemek",
					installmentCount: 1,
					split: {
						splitId: "split-1",
						status: "ACTIVE",
						userShareAmount: "100.00",
						externalShareAmount: "200.00",
						splitMethod: "EQUAL",
						participantCount: 2,
					},
					purchaseDate: "2026-03-29",
					occurredAt: "2026-03-29T12:00:00Z",
				},
				split: {
					splitId: "split-1",
					purchaseId: "pur-shared-1",
					cardId: "card-1",
					status: "ACTIVE",
					revisionNo: 1,
					splitMethod: "EQUAL",
					grossAmount: "300.00",
					userShareAmount: "100.00",
					externalShareAmount: "200.00",
					userWeight: null,
					participants: [
						{
							participantId: "part-1",
							personId: "p-ali",
							displayName: "Ali Veli",
							shareAmount: "100.00",
							obligationId: "ob-1",
							remainingAmount: "100.00",
						},
						{
							participantId: "part-2",
							personId: "p-ayse",
							displayName: "Ayşe Kaya",
							shareAmount: "100.00",
							obligationId: "ob-2",
							remainingAmount: "100.00",
						},
					],
				},
			});

		const onSuccess = vi.fn();
		render(<SharedPurchaseForm cardId="card-1" onSuccess={onSuccess} />, {
			wrapper: createWrapper(),
		});

		// Wait for candidate options to populate
		await waitFor(() => {
			expect(
				screen.getByRole("option", { name: /Ali Veli/i }),
			).toBeInTheDocument();
		});

		// Fill purchase fields
		fireEvent.change(screen.getByTestId("money-input"), {
			target: { value: "300.00" },
		});
		fireEvent.change(screen.getByLabelText(/Açıklama/i), {
			target: { value: "Yemek" },
		});

		// Add participants
		fireEvent.change(screen.getByTestId("candidate-person-select"), {
			target: { value: "p-ali" },
		});
		fireEvent.click(screen.getByTestId("add-participant-btn"));

		await waitFor(() => {
			expect(
				screen.getByRole("option", { name: /Ayşe Kaya/i }),
			).toBeInTheDocument();
		});

		fireEvent.change(screen.getByTestId("candidate-person-select"), {
			target: { value: "p-ayse" },
		});
		fireEvent.click(screen.getByTestId("add-participant-btn"));

		// EQUAL is default split method, button should now be enabled
		await waitFor(() => {
			expect(
				screen.getByTestId("submit-shared-purchase-button"),
			).not.toBeDisabled();
		});

		fireEvent.click(screen.getByTestId("submit-shared-purchase-button"));

		await waitFor(() => {
			expect(mockSharedCreate).toHaveBeenCalledTimes(1);
		});

		const [cardId, payload, key] = mockSharedCreate.mock.calls[0]!;
		expect(cardId).toBe("card-1");
		expect(payload.amount).toBe("300.00");
		expect(payload.splitMethod).toBe("EQUAL");
		expect(payload.userWeight).toBeUndefined();
		expect(typeof key).toBe("string");

		// Contract: In EQUAL split, participant entries must NOT have shareAmount or weight!
		for (const p of payload.participants) {
			expect(p.shareAmount).toBeUndefined();
			expect(p.weight).toBeUndefined();
		}

		// Result confirmation shows server-returned amounts
		await waitFor(() => {
			const rows = screen.getAllByTestId("obligation-confirm-row");
			expect(rows).toHaveLength(2);
			expect(rows[0]).toHaveTextContent("Ali Veli");
			expect(rows[0]).toHaveTextContent("₺100,00");
			expect(rows[1]).toHaveTextContent("Ayşe Kaya");
			expect(rows[1]).toHaveTextContent("₺100,00");
		});
	});

	it("submits atomic shared purchase for MANUAL split sending shareAmount and no weight/userWeight", async () => {
		vi.spyOn(creditCardsApi, "fetchAllActivePeople").mockResolvedValue([
			{ personId: "p-ali", displayName: "Ali Veli", relationship: "FRIEND" },
		]);
		vi.spyOn(manualExpensesApi, "fetchSpendingCategories").mockResolvedValue({
			categories: [],
		});

		const mockSharedCreate = vi
			.spyOn(creditCardsApi, "createSharedCreditCardPurchase")
			.mockResolvedValue({
				purchase: {
					purchaseId: "p-1",
					amount: "200.00",
					personalExpenseAmount: "120.00",
					externalReceivableAmount: "80.00",
					occurredAt: "2026-03-29T10:00:00Z",
				} as any,
				split: {
					splitId: "s-1",
					purchaseId: "p-1",
					cardId: "card-1",
					status: "ACTIVE",
					revisionNo: 1,
					splitMethod: "MANUAL",
					grossAmount: "200.00",
					userShareAmount: "120.00",
					externalShareAmount: "80.00",
					userWeight: null,
					participants: [
						{
							participantId: "part-1",
							personId: "p-ali",
							displayName: "Ali Veli",
							shareAmount: "80.00",
							obligationId: "ob-1",
							remainingAmount: "80.00",
						},
					],
				},
			});

		render(<SharedPurchaseForm cardId="card-1" />, {
			wrapper: createWrapper(),
		});

		await waitFor(() => {
			expect(
				screen.getByRole("option", { name: /Ali Veli/i }),
			).toBeInTheDocument();
		});

		fireEvent.change(screen.getByTestId("money-input"), {
			target: { value: "200.00" },
		});
		fireEvent.click(screen.getByTestId("split-method-manual")); // Switch to MANUAL

		fireEvent.change(screen.getByTestId("candidate-person-select"), {
			target: { value: "p-ali" },
		});
		fireEvent.click(screen.getByTestId("add-participant-btn"));

		await waitFor(() => {
			expect(screen.getByTestId("participant-share-p-ali")).toBeInTheDocument();
		});

		fireEvent.change(screen.getByTestId("participant-share-p-ali"), {
			target: { value: "80.00" },
		});

		await waitFor(() => {
			expect(
				screen.getByTestId("submit-shared-purchase-button"),
			).not.toBeDisabled();
		});

		fireEvent.click(screen.getByTestId("submit-shared-purchase-button"));

		await waitFor(() => {
			expect(mockSharedCreate).toHaveBeenCalledTimes(1);
		});

		const [, payload] = mockSharedCreate.mock.calls[0]!;
		expect(payload.splitMethod).toBe("MANUAL");
		expect(payload.userWeight).toBeUndefined();
		expect(payload.participants[0]?.shareAmount).toBe("80.00");
		expect(payload.participants[0]?.weight).toBeUndefined();
	});

	it("uses coordinated shared-void for active shared purchase instead of unshared void", async () => {
		const sharedPurchase: creditCardsApi.CreditCardPurchaseItem = {
			purchaseId: "pur-shared-99",
			cardId: "card-1",
			status: "POSTED",
			revisionNo: 2,
			amount: "500.00",
			personalExpenseAmount: "250.00",
			externalReceivableAmount: "250.00",
			purchaseCategory: "FOOD_GROCERY",
			merchant: "Metro Market",
			description: null,
			installmentCount: 1,
			split: {
				splitId: "split-99",
				status: "ACTIVE",
				userShareAmount: "250.00",
				externalShareAmount: "250.00",
				splitMethod: "EQUAL",
				participantCount: 1,
			},
			purchaseDate: "2026-03-29",
			occurredAt: "2026-03-29T10:00:00Z",
		};

		const splitDetail: creditCardsApi.PurchaseSplitItem = {
			splitId: "split-99",
			purchaseId: "pur-shared-99",
			cardId: "card-1",
			status: "ACTIVE",
			revisionNo: 3,
			splitMethod: "EQUAL",
			grossAmount: "500.00",
			userShareAmount: "250.00",
			externalShareAmount: "250.00",
			userWeight: null,
			participants: [
				{
					participantId: "part-1",
					personId: "p-ali",
					displayName: "Ali Veli",
					shareAmount: "250.00",
					obligationId: "ob-1",
					remainingAmount: "250.00",
				},
			],
		};

		vi.spyOn(creditCardsApi, "fetchCreditCardPurchase").mockResolvedValue({
			purchase: sharedPurchase,
		});
		vi.spyOn(creditCardsApi, "fetchPurchaseSplit").mockResolvedValue({
			split: splitDetail,
		});

		const mockSharedVoid = vi
			.spyOn(creditCardsApi, "voidSharedCreditCardPurchase")
			.mockResolvedValue({
				purchase: { ...sharedPurchase, status: "VOID" },
				split: { ...splitDetail, status: "VOID" },
			});

		const mockUnsharedVoid = vi.spyOn(creditCardsApi, "voidCreditCardPurchase");

		await renderWithRouter(
			<PurchaseDetailPage cardId="card-1" purchaseId="pur-shared-99" />,
		);

		await waitFor(() => {
			expect(
				screen.getByRole("heading", { name: "Metro Market" }),
			).toBeInTheDocument();
		});

		// Click Void button
		fireEvent.click(screen.getByTestId("void-purchase-btn"));

		// Modal opens
		await waitFor(() => {
			expect(
				screen.getByTestId("confirm-void-purchase-btn"),
			).toBeInTheDocument();
		});

		fireEvent.click(screen.getByTestId("confirm-void-purchase-btn"));

		await waitFor(() => {
			expect(mockSharedVoid).toHaveBeenCalledTimes(1);
		});

		// Must NOT call unshared void!
		expect(mockUnsharedVoid).not.toHaveBeenCalled();

		const [cId, pId, payload] = mockSharedVoid.mock.calls[0]!;
		expect(cId).toBe("card-1");
		expect(pId).toBe("pur-shared-99");
		expect(payload.expectedPurchaseRevisionNo).toBe(2);
		expect(payload.expectedSplitRevisionNo).toBe(3);
	});

	it("shows natural remediation copy when backend returns CREDIT_CARD_SPLIT_CONFLICT due to settled shares", async () => {
		const sharedPurchase: creditCardsApi.CreditCardPurchaseItem = {
			purchaseId: "pur-shared-settled",
			cardId: "card-1",
			status: "POSTED",
			revisionNo: 1,
			amount: "600.00",
			personalExpenseAmount: "300.00",
			externalReceivableAmount: "300.00",
			purchaseCategory: "FOOD_GROCERY",
			merchant: "Migros",
			description: null,
			installmentCount: 1,
			split: {
				splitId: "split-settled",
				status: "ACTIVE",
				userShareAmount: "300.00",
				externalShareAmount: "300.00",
				splitMethod: "EQUAL",
				participantCount: 1,
			},
			purchaseDate: "2026-03-29",
			occurredAt: "2026-03-29T10:00:00Z",
		};

		vi.spyOn(creditCardsApi, "fetchCreditCardPurchase").mockResolvedValue({
			purchase: sharedPurchase,
		});
		vi.spyOn(creditCardsApi, "fetchPurchaseSplit").mockResolvedValue({
			split: {
				splitId: "split-settled",
				purchaseId: "pur-shared-settled",
				cardId: "card-1",
				status: "ACTIVE",
				revisionNo: 1,
				splitMethod: "EQUAL",
				grossAmount: "600.00",
				userShareAmount: "300.00",
				externalShareAmount: "300.00",
				userWeight: null,
				participants: [],
			},
		});

		vi.spyOn(creditCardsApi, "voidSharedCreditCardPurchase").mockRejectedValue({
			status: 409,
			code: "CREDIT_CARD_SPLIT_CONFLICT",
			message: "Settled share conflict",
		});

		await renderWithRouter(
			<PurchaseDetailPage cardId="card-1" purchaseId="pur-shared-settled" />,
		);

		await waitFor(() => {
			expect(screen.getByTestId("void-purchase-btn")).toBeInTheDocument();
		});

		fireEvent.click(screen.getByTestId("void-purchase-btn"));

		await waitFor(() => {
			expect(
				screen.getByTestId("confirm-void-purchase-btn"),
			).toBeInTheDocument();
		});

		fireEvent.click(screen.getByTestId("confirm-void-purchase-btn"));

		await waitFor(() => {
			expect(
				screen.getByText(
					/Bu ortak harcamanın bazı paylarında tahsilat kaydı bulunduğu için değişiklik bu şekilde yapılamıyor/i,
				),
			).toBeInTheDocument();
		});
	});
});

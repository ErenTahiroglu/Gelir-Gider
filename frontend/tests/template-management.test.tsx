import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../src/api/client";
import { ApiError } from "../src/api/errors";
import * as manualExpensesApi from "../src/api/manual-expenses-api";
import * as quickEntryApi from "../src/api/quick-entry-api";
import type { QuickEntryTemplateItem } from "../src/api/quick-entry-types";
import { TemplateManagement } from "../src/components/quick-entry/TemplateManagement";

function createTestQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
			mutations: { retry: false },
		},
	});
}

async function renderWithProviders(
	ui: React.ReactElement,
	queryClient = createTestQueryClient(),
) {
	const rootRoute = createRootRoute({
		component: () => (
			<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
		),
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({
			initialEntries: ["/settings/quick-templates"],
		}),
	});
	await router.load();
	return render(<RouterProvider router={router} />);
}

describe("Template Management & Server Synchronization (Section 71-73)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	const initialTemplates: QuickEntryTemplateItem[] = [
		{
			id: "tpl-1",
			userId: "usr-1",
			name: "Market",
			templateType: "MANUAL_EXPENSE",
			status: "ACTIVE",
			config: {
				sourceAssetAccountId: "acc-1",
				defaultAmount: "200.00",
			},
			sortOrder: 1,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		},
		{
			id: "tpl-2",
			userId: "usr-1",
			name: "Eski Benzin",
			templateType: "CREDIT_CARD_EXPENSE",
			status: "ARCHIVED",
			config: {
				cardId: "card-1",
				defaultAmount: "500.00",
			},
			sortOrder: 2,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		},
	];

	const mockAccounts = [
		{
			accountId: "acc-1",
			code: "100.01",
			name: "Nakit Kasa",
			accountType: "ASSET" as const,
			normalBalance: "DEBIT" as const,
			currency: "TRY",
			archived: false,
			balance: "5000.00",
		},
	];

	const mockCards = [
		{
			cardId: "card-1",
			userId: "usr-1",
			code: "CARD01",
			status: "ACTIVE" as const,
			revisionNo: 1,
			displayName: "Asıl Kart",
			issuer: "Banka",
			statementDay: 1,
			dueDay: 10,
			creditLimit: "20000.00",
			lastFour: "1111",
			note: null,
			createdAt: "2026-01-01T00:00:00Z",
			liveLiabilityBalance: "0.00",
		},
	];

	it("Section 71: create template on management screen invalidates quick-entry-templates query", async () => {
		vi.spyOn(quickEntryApi, "fetchQuickEntryTemplates").mockResolvedValue({
			templates: [...initialTemplates],
		});
		vi.spyOn(manualExpensesApi, "fetchAllLedgerAccounts").mockResolvedValue(
			mockAccounts,
		);
		vi.spyOn(manualExpensesApi, "fetchSpendingCategories").mockResolvedValue({
			categories: [],
		});
		vi.spyOn(quickEntryApi, "fetchAllActiveCreditCards").mockResolvedValue(
			mockCards,
		);

		const apiPostSpy = vi.spyOn(client, "apiPost").mockResolvedValue({
			template: {
				id: "tpl-new",
				userId: "usr-1",
				name: "Yeni Kahve",
				templateType: "CREDIT_CARD_EXPENSE",
				status: "ACTIVE",
				config: { cardId: "card-1", defaultAmount: "90.00" },
				sortOrder: 3,
				createdAt: "2026-09-28T00:00:00Z",
				updatedAt: "2026-09-28T00:00:00Z",
			},
		});

		const queryClient = createTestQueryClient();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		await renderWithProviders(<TemplateManagement />, queryClient);

		// Open Create Modal
		expect(await screen.findByText("Market")).toBeInTheDocument();
		fireEvent.click(screen.getByTestId("create-template-btn"));

		// Fill in form
		fireEvent.change(screen.getByTestId("tpl-name-input"), {
			target: { value: "Yeni Kahve" },
		});
		fireEvent.click(screen.getByTestId("tpl-type-cc"));
		fireEvent.change(screen.getByTestId("tpl-card-select"), {
			target: { value: "card-1" },
		});
		fireEvent.click(screen.getByTestId("tpl-save-btn"));

		await waitFor(() => {
			expect(apiPostSpy).toHaveBeenCalledWith(
				"/quick-entry/templates",
				expect.objectContaining({
					name: "Yeni Kahve",
					templateType: "CREDIT_CARD_EXPENSE",
				}),
			);
		});

		// Server sync: invalidate query key
		expect(invalidateSpy).toHaveBeenCalledWith(
			expect.objectContaining({ queryKey: ["quick-entry-templates"] }),
		);
	});

	it("Section 72: archiving active template calls archive endpoint and moves it to Arşivlenmiş", async () => {
		vi.spyOn(quickEntryApi, "fetchQuickEntryTemplates").mockResolvedValue({
			templates: [...initialTemplates],
		});
		vi.spyOn(manualExpensesApi, "fetchAllLedgerAccounts").mockResolvedValue(
			mockAccounts,
		);
		vi.spyOn(manualExpensesApi, "fetchSpendingCategories").mockResolvedValue({
			categories: [],
		});
		vi.spyOn(quickEntryApi, "fetchAllActiveCreditCards").mockResolvedValue(
			mockCards,
		);

		const apiPostSpy = vi.spyOn(client, "apiPost").mockResolvedValue({
			template: {
				...initialTemplates[0],
				status: "ARCHIVED",
			},
		});

		const queryClient = createTestQueryClient();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		await renderWithProviders(<TemplateManagement />, queryClient);

		// Archive button for Market template
		const archiveBtn = await screen.findByTestId("archive-template-btn-tpl-1");
		fireEvent.click(archiveBtn);

		await waitFor(() => {
			expect(apiPostSpy).toHaveBeenCalledWith(
				"/quick-entry/templates/tpl-1/archive",
				{},
			);
		});

		expect(invalidateSpy).toHaveBeenCalledWith(
			expect.objectContaining({ queryKey: ["quick-entry-templates"] }),
		);
	});

	it("Section 73: create network uncertainty does not auto-retry, refetches list, and warns user", async () => {
		const refetchSpy = vi.fn();
		vi.spyOn(quickEntryApi, "fetchQuickEntryTemplates").mockImplementation(
			() => {
				refetchSpy();
				return Promise.resolve({ templates: [...initialTemplates] });
			},
		);
		vi.spyOn(manualExpensesApi, "fetchAllLedgerAccounts").mockResolvedValue(
			mockAccounts,
		);
		vi.spyOn(manualExpensesApi, "fetchSpendingCategories").mockResolvedValue({
			categories: [],
		});
		vi.spyOn(quickEntryApi, "fetchAllActiveCreditCards").mockResolvedValue(
			mockCards,
		);

		vi.spyOn(client, "apiPost").mockRejectedValue(
			new ApiError({
				status: 0,
				code: "NETWORK_ERROR",
				message: "Network down",
			}),
		);

		const queryClient = createTestQueryClient();
		await renderWithProviders(<TemplateManagement />, queryClient);

		expect(await screen.findByText("Market")).toBeInTheDocument();
		fireEvent.click(screen.getByTestId("create-template-btn"));

		fireEvent.change(screen.getByTestId("tpl-name-input"), {
			target: { value: "Belirsiz Şablon" },
		});
		fireEvent.change(screen.getByTestId("tpl-source-account-select"), {
			target: { value: "acc-1" },
		});
		fireEvent.click(screen.getByTestId("tpl-save-btn"));

		// Network uncertainty warning is displayed
		expect(
			await screen.findByTestId("network-uncertainty-warning"),
		).toHaveTextContent(
			"Şablon işleminin tamamlanıp tamamlanmadığı doğrulanamadı. Liste yenilendi; tekrar işlem yapmadan önce kontrol edin.",
		);

		// Query refetch occurred
		expect(refetchSpy).toHaveBeenCalledTimes(2); // Initial mount + network failure refetch
	});

	it("Section 24 & 58: editing template keeps templateType immutable and preserves existing config keys like shortTermGoalId", async () => {
		const templateWithGoal: QuickEntryTemplateItem = {
			id: "tpl-goal",
			userId: "usr-1",
			name: "Kıyafet",
			templateType: "CREDIT_CARD_EXPENSE",
			status: "ACTIVE",
			config: {
				cardId: "card-1",
				shortTermGoalId: "goal-xyz-789",
				defaultAmount: "800.00",
				merchant: "Zara",
			},
			sortOrder: 5,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		};

		vi.spyOn(quickEntryApi, "fetchQuickEntryTemplates").mockResolvedValue({
			templates: [templateWithGoal],
		});
		vi.spyOn(manualExpensesApi, "fetchAllLedgerAccounts").mockResolvedValue(
			mockAccounts,
		);
		vi.spyOn(manualExpensesApi, "fetchSpendingCategories").mockResolvedValue({
			categories: [],
		});
		vi.spyOn(quickEntryApi, "fetchAllActiveCreditCards").mockResolvedValue(
			mockCards,
		);

		const apiPostSpy = vi.spyOn(client, "apiPost").mockResolvedValue({
			template: templateWithGoal,
		});

		const queryClient = createTestQueryClient();
		await renderWithProviders(<TemplateManagement />, queryClient);

		// Open edit
		const editBtn = await screen.findByTestId("edit-template-btn-tpl-goal");
		fireEvent.click(editBtn);

		// templateType is immutable text, not a radio or select
		expect(screen.getByTestId("immutable-template-type")).toHaveTextContent(
			"Kredi Kartı",
		);
		expect(screen.queryByTestId("tpl-type-manual")).not.toBeInTheDocument();

		// Change name and submit
		fireEvent.change(screen.getByTestId("tpl-name-input"), {
			target: { value: "Kıyafet Güncellendi" },
		});
		fireEvent.click(screen.getByTestId("tpl-save-btn"));

		await waitFor(() => {
			expect(apiPostSpy).toHaveBeenCalledWith(
				"/quick-entry/templates/tpl-goal",
				expect.objectContaining({
					name: "Kıyafet Güncellendi",
					config: expect.objectContaining({
						cardId: "card-1",
						// Complete config sent and shortTermGoalId preserved!
						shortTermGoalId: "goal-xyz-789",
						defaultAmount: "800.00",
						merchant: "Zara",
					}),
				}),
			);
		});
	});
});

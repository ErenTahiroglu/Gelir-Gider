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
import * as manualExpensesApi from "../src/api/manual-expenses-api";
import * as quickEntryApi from "../src/api/quick-entry-api";
import type { QuickEntryTemplateItem } from "../src/api/quick-entry-types";
import { QuickTemplatesStrip } from "../src/components/dashboard/QuickTemplatesStrip";
import { AppShell } from "../src/components/layout/AppShell";
import { QuickEntryProvider } from "../src/context/QuickEntryContext";

// Mock AuthContext for shell
vi.mock("../src/auth/auth-context", () => ({
	useAuth: () => ({
		state: { status: "UNLOCKED", user: { displayName: "Eren" } },
		lockNow: vi.fn(),
		logout: vi.fn(),
	}),
}));

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
			<QueryClientProvider client={queryClient}>
				<QuickEntryProvider>{ui}</QuickEntryProvider>
			</QueryClientProvider>
		),
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	await router.load();
	return render(<RouterProvider router={router} />);
}

describe("Quick Entry FAB, Sheet & Manual Execution (Section 62-66)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	const mockTemplates: QuickEntryTemplateItem[] = [
		{
			id: "tpl-market",
			userId: "user-1",
			name: "Migros Market",
			templateType: "MANUAL_EXPENSE",
			status: "ACTIVE",
			config: {
				sourceAssetAccountId: "acc-bank",
				spendingCategoryId: "cat-groceries",
				budgetCategoryOverride: "MANDATORY_EXPENSE",
				merchant: "Migros",
				description: "Haftalık Alışveriş",
				defaultAmount: "350.00",
			},
			sortOrder: 1,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		},
		{
			id: "tpl-no-amount",
			userId: "user-1",
			name: "Tutar Yok",
			templateType: "MANUAL_EXPENSE",
			status: "ACTIVE",
			config: {
				sourceAssetAccountId: "acc-bank",
				spendingCategoryId: "cat-groceries",
				budgetCategoryOverride: "MANDATORY_EXPENSE",
			},
			sortOrder: 2,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		},
	];

	const mockAccounts = [
		{
			accountId: "acc-bank",
			code: "102.01",
			name: "Vadesiz TL",
			accountType: "ASSET" as const,
			normalBalance: "DEBIT" as const,
			currency: "TRY",
			archived: false,
			balance: "10000.00",
		},
	];

	const mockCategories = [
		{
			id: "cat-groceries",
			userId: "user-1",
			name: "Market",
			defaultBudgetCategory: "MANDATORY_EXPENSE" as const,
			status: "ACTIVE" as const,
			sortOrder: 1,
			systemDefined: false,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		},
	];

	it("Section 62: tap central + opens Quick Entry sheet without page reload, and close returns", async () => {
		vi.spyOn(quickEntryApi, "fetchQuickEntryTemplates").mockResolvedValue({
			templates: mockTemplates,
		});

		await renderWithProviders(
			<AppShell>
				<div data-testid="page-child">Sayfa İçeriği</div>
			</AppShell>,
		);

		// Sheet is initially closed
		expect(screen.queryByTestId("quick-entry-sheet")).not.toBeInTheDocument();
		expect(screen.getByTestId("page-child")).toBeInTheDocument();

		// Tap mobile central + FAB
		const fab = screen.getByTestId("mobile-quick-entry-fab");
		expect(fab).not.toBeDisabled();
		fireEvent.click(fab);

		// Sheet opens immediately
		expect(await screen.findByTestId("quick-entry-sheet")).toBeInTheDocument();

		// Close button closes sheet and returns to underlying view
		const closeBtn = screen.getByTestId("modal-close-btn");
		fireEvent.click(closeBtn);

		await waitFor(() => {
			expect(screen.queryByTestId("quick-entry-sheet")).not.toBeInTheDocument();
		});
		expect(screen.getByTestId("page-child")).toBeInTheDocument();
	});

	it("Section 63: Dashboard template chip tap opens sheet with template preselected", async () => {
		vi.spyOn(quickEntryApi, "fetchQuickEntryTemplates").mockResolvedValue({
			templates: mockTemplates,
		});
		vi.spyOn(manualExpensesApi, "fetchAllLedgerAccounts").mockResolvedValue(
			mockAccounts,
		);
		vi.spyOn(manualExpensesApi, "fetchSpendingCategories").mockResolvedValue({
			categories: mockCategories,
		});

		// Component containing both QuickTemplatesStrip and the Sheet via AppShell
		await renderWithProviders(
			<AppShell>
				<QuickTemplatesStrip isUnlocked={true} />
			</AppShell>,
		);

		// Click the Migros template chip on dashboard
		const chip = await screen.findByTestId("template-chip-tpl-market");
		fireEvent.click(chip);

		// Quick Entry sheet opens with the template directly loaded into form (no extra template selection tap!)
		expect(await screen.findByTestId("quick-entry-sheet")).toBeInTheDocument();
		expect(screen.getByTestId("manual-expense-form")).toBeInTheDocument();
		expect(screen.getByDisplayValue("350,00")).toBeInTheDocument();
	});

	it("Section 64: MANUAL_EXPENSE template prefills form and executes via POST /manual-expenses", async () => {
		vi.spyOn(quickEntryApi, "fetchQuickEntryTemplates").mockResolvedValue({
			templates: mockTemplates,
		});
		vi.spyOn(manualExpensesApi, "fetchAllLedgerAccounts").mockResolvedValue(
			mockAccounts,
		);
		vi.spyOn(manualExpensesApi, "fetchSpendingCategories").mockResolvedValue({
			categories: mockCategories,
		});
		vi.spyOn(manualExpensesApi, "fetchCategoryAssignment").mockResolvedValue({
			assignments: { "tx-999": "cat-groceries" },
		});
		const apiPostSpy = vi.spyOn(client, "apiPost").mockResolvedValue({
			transactionId: "tx-999",
			expenseId: "exp-999",
			revisionNo: 1,
		});

		await renderWithProviders(
			<AppShell>
				<QuickTemplatesStrip isUnlocked={true} />
			</AppShell>,
		);

		// Open template
		const chip = await screen.findByTestId("template-chip-tpl-market");
		fireEvent.click(chip);

		// Verify exact prefill
		expect(await screen.findByDisplayValue("Migros")).toBeInTheDocument();
		expect(screen.getByDisplayValue("Haftalık Alışveriş")).toBeInTheDocument();
		expect(screen.getByDisplayValue("350,00")).toBeInTheDocument();

		// Wait for accounts and categories to resolve and prefill
		await waitFor(() => {
			expect(screen.getByTestId("expense-account-select")).toHaveValue(
				"acc-bank",
			);
		});

		// Happy path 3rd tap: Save
		const submitBtn = screen.getByTestId("expense-submit-btn");
		fireEvent.click(submitBtn);

		await waitFor(() => {
			expect(apiPostSpy).toHaveBeenCalledWith(
				"/manual-expenses",
				expect.objectContaining({
					amount: "350.00",
					sourceAssetAccountId: "acc-bank",
					spendingCategoryId: "cat-groceries",
					budgetCategory: "MANDATORY_EXPENSE",
					merchant: "Migros",
					description: "Haftalık Alışveriş",
				}),
				expect.objectContaining({
					headers: expect.objectContaining({
						"Idempotency-Key": expect.any(String),
					}),
				}),
			);
		});
	});

	it("Section 65: template with missing defaultAmount leaves amount blank, focused, blocks zero submission", async () => {
		vi.spyOn(quickEntryApi, "fetchQuickEntryTemplates").mockResolvedValue({
			templates: mockTemplates,
		});
		vi.spyOn(manualExpensesApi, "fetchAllLedgerAccounts").mockResolvedValue(
			mockAccounts,
		);
		vi.spyOn(manualExpensesApi, "fetchSpendingCategories").mockResolvedValue({
			categories: mockCategories,
		});
		const apiPostSpy = vi.spyOn(client, "apiPost");

		await renderWithProviders(
			<AppShell>
				<QuickTemplatesStrip isUnlocked={true} />
			</AppShell>,
		);

		const chip = await screen.findByTestId("template-chip-tpl-no-amount");
		fireEvent.click(chip);

		// Form is open, amount input is blank
		const amountInput = await screen.findByTestId("money-input");
		expect(amountInput).toHaveValue("");

		// Save button is disabled while amount is invalid / blank
		const submitBtn = screen.getByTestId("expense-submit-btn");
		expect(submitBtn).toBeDisabled();

		// Cannot submit
		fireEvent.click(submitBtn);
		expect(apiPostSpy).not.toHaveBeenCalled();

		// Entering a valid amount enables submit
		fireEvent.change(amountInput, { target: { value: "45,50" } });
		expect(submitBtn).not.toBeDisabled();
	});

	it("Section 66: stale explicit account or category references block submission and display warnings", async () => {
		const staleTemplate: QuickEntryTemplateItem = {
			id: "tpl-stale",
			userId: "user-1",
			name: "Eski Şablon",
			templateType: "MANUAL_EXPENSE",
			status: "ACTIVE",
			config: {
				sourceAssetAccountId: "acc-defunct",
				spendingCategoryId: "cat-archived",
				defaultAmount: "200.00",
			},
			sortOrder: 1,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		};

		vi.spyOn(quickEntryApi, "fetchQuickEntryTemplates").mockResolvedValue({
			templates: [staleTemplate],
		});
		// mockAccounts does NOT contain acc-defunct
		vi.spyOn(manualExpensesApi, "fetchAllLedgerAccounts").mockResolvedValue(
			mockAccounts,
		);
		// mockCategories does NOT contain cat-archived
		vi.spyOn(manualExpensesApi, "fetchSpendingCategories").mockResolvedValue({
			categories: mockCategories,
		});
		const apiPostSpy = vi.spyOn(client, "apiPost");

		await renderWithProviders(
			<AppShell>
				<QuickTemplatesStrip isUnlocked={true} />
			</AppShell>,
		);

		const chip = await screen.findByTestId("template-chip-tpl-stale");
		fireEvent.click(chip);

		// Stale warnings are shown
		expect(
			await screen.findByTestId("stale-account-warning"),
		).toHaveTextContent("Şablondaki ödeme kaynağı artık kullanılamıyor.");
		expect(screen.getByTestId("stale-category-warning")).toHaveTextContent(
			"Şablondaki kategori artık kullanılamıyor.",
		);

		// Trying to submit blocks financial POST
		const form = screen.getByTestId("manual-expense-form");
		fireEvent.submit(form);
		expect(apiPostSpy).not.toHaveBeenCalled();
	});
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as creditCardsApi from "../src/api/credit-cards-api";
import * as manualExpensesApi from "../src/api/manual-expenses-api";
import * as peopleApi from "../src/api/people-api";
import * as quickEntryApi from "../src/api/quick-entry-api";
import type { QuickEntryTemplateItem } from "../src/api/quick-entry-types";
import { AppShell } from "../src/components/layout/AppShell";
import { DesktopSidebar } from "../src/components/layout/DesktopSidebar";
import { MobileNav } from "../src/components/layout/MobileNav";
import { TemplateManagement } from "../src/components/quick-entry/TemplateManagement";
import { QuickEntryProvider } from "../src/context/QuickEntryContext";

vi.mock("../src/api/quick-entry-api");
vi.mock("../src/api/people-api");
vi.mock("../src/api/manual-expenses-api");
vi.mock("../src/api/credit-cards-api");

// Mock AuthContext for AppShell
vi.mock("../src/auth/auth-context", () => ({
	useAuth: () => ({
		state: { status: "UNLOCKED", user: { displayName: "Eren" } },
		lockNow: vi.fn(),
		logout: vi.fn(),
	}),
}));

async function renderWithRouter(
	ui: React.ReactElement,
	initialPath: string = "/",
) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
			mutations: { retry: false },
		},
	});

	const rootRoute = createRootRoute({
		component: () => (
			<QueryClientProvider client={queryClient}>
				<QuickEntryProvider>{ui}</QuickEntryProvider>
			</QueryClientProvider>
		),
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: [initialPath] }),
	});
	await router.load();

	return render(<RouterProvider router={router} />);
}

describe("F6 Navigation & Quick Entry Templates — More Hub, Desktop & Obligation Templates", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		vi.spyOn(manualExpensesApi, "fetchAllLedgerAccounts").mockResolvedValue([
			{
				accountId: "acc-bank",
				code: "102.01",
				name: "Vakıfbank Vadesiz",
				accountType: "ASSET",
				normalBalance: "DEBIT",
				currency: "TRY",
				archived: false,
				balance: "5000.00",
			},
		]);

		vi.spyOn(manualExpensesApi, "fetchSpendingCategories").mockResolvedValue({
			categories: [],
		});
		vi.spyOn(creditCardsApi, "fetchCreditCards").mockResolvedValue({
			cards: [],
			nextCursor: null,
		});
	});

	it("renders MobileNav with active state on /people and opens accessible More Hub", async () => {
		await renderWithRouter(<MobileNav />, "/people");

		const moreBtn = screen.getByTestId("mobile-nav-more");
		expect(moreBtn).toBeInTheDocument();
		expect(moreBtn).not.toBeDisabled();
		// Assert active class when on /people
		expect(moreBtn).toHaveClass("active");

		// Open More Hub
		fireEvent.click(moreBtn);

		await waitFor(() => {
			expect(screen.getByTestId("more-hub-sheet")).toBeInTheDocument();
		});

		// Kişiler link active and points to /people
		const peopleLink = screen.getByTestId("more-hub-link-people");
		expect(peopleLink).toHaveAttribute("href", "/people");

		// F7 domain links active
		expect(screen.getByTestId("more-hub-link-midas")).toHaveAttribute(
			"href",
			"/midas",
		);
		expect(screen.getByTestId("more-hub-link-goals")).toHaveAttribute(
			"href",
			"/goals",
		);
		expect(screen.getByTestId("more-hub-link-long-term")).toHaveAttribute(
			"href",
			"/long-term",
		);

		// F8 activated domains: Income & Month Close
		expect(screen.getByTestId("more-hub-link-income")).toHaveAttribute(
			"href",
			"/income",
		);
		expect(screen.getByTestId("more-hub-link-month-close")).toHaveAttribute(
			"href",
			"/month-close",
		);

		// Active F9 import link
		expect(
			screen.getByTestId("more-hub-link-statement-import"),
		).toHaveAttribute("href", "/imports");
		// Future domain links disabled
		expect(screen.getByTestId("more-hub-link-campaigns")).toHaveClass(
			"disabled",
		);
	});

	it("renders DesktopSidebar with Kişiler link active on /people", async () => {
		await renderWithRouter(
			<DesktopSidebar collapsed={false} onToggleCollapse={vi.fn()} />,
			"/people",
		);

		const peopleLink = screen.getByTestId("nav-link-people");
		expect(peopleLink).toBeInTheDocument();
		expect(peopleLink).not.toBeDisabled();
		expect(peopleLink).toHaveAttribute("href", "/people");
		expect(peopleLink).toHaveAttribute("aria-current", "page");

		// F7 links active
		expect(screen.getByTestId("nav-link-midas")).toHaveAttribute(
			"href",
			"/midas",
		);
		expect(screen.getByTestId("nav-link-goals")).toHaveAttribute(
			"href",
			"/goals",
		);
		expect(screen.getByTestId("nav-link-long-term")).toHaveAttribute(
			"href",
			"/long-term",
		);
	});

	it("creates a RECEIVABLE template with config strictly containing personId, description, defaultAmount, dueDate", async () => {
		vi.spyOn(peopleApi, "fetchAllActivePeople").mockResolvedValue([
			{
				personId: "p1",
				status: "ACTIVE",
				displayName: "Burak Yılmaz",
				relationship: "FRIEND",
				note: null,
				revisionNo: 1,
				receivableBalance: "0.00",
				payableBalance: "0.00",
			},
		]);

		vi.spyOn(quickEntryApi, "fetchQuickEntryTemplates").mockResolvedValue({
			templates: [],
		});

		const mockCreateTemplate = vi
			.spyOn(quickEntryApi, "createQuickEntryTemplate")
			.mockResolvedValue({
				template: {
					id: "tpl-rec-1",
					userId: "usr-1",
					name: "Burak Borç Şablonu",
					templateType: "RECEIVABLE",
					status: "ACTIVE",
					sortOrder: 1,
					config: {
						personId: "p1",
						description: "Haftalık borç",
						defaultAmount: "250.00",
						dueDate: "2026-04-01",
					},
					createdAt: "2026-03-29T10:00:00Z",
					updatedAt: "2026-03-29T10:00:00Z",
				},
			});

		await renderWithRouter(<TemplateManagement />);

		await waitFor(() => {
			expect(screen.getByTestId("create-template-btn")).toBeInTheDocument();
		});

		fireEvent.click(screen.getByTestId("create-template-btn"));

		await waitFor(() => {
			expect(screen.getByTestId("tpl-type-receivable")).toBeInTheDocument();
		});

		// Select RECEIVABLE type
		fireEvent.click(screen.getByTestId("tpl-type-receivable"));

		// Fill name
		fireEvent.change(screen.getByTestId("tpl-name-input"), {
			target: { value: "Burak Borç Şablonu" },
		});

		// Select Person
		await waitFor(() => {
			expect(screen.getByTestId("tpl-person-select")).toBeInTheDocument();
		});
		fireEvent.change(screen.getByTestId("tpl-person-select"), {
			target: { value: "p1" },
		});

		// Fill Amount
		fireEvent.change(screen.getByTestId("money-input"), {
			target: { value: "250.00" },
		});

		// Fill description and due date
		fireEvent.change(screen.getByTestId("tpl-person-description-input"), {
			target: { value: "Haftalık borç" },
		});
		fireEvent.change(screen.getByTestId("tpl-duedate-input"), {
			target: { value: "2026-04-01" },
		});

		// Save template
		fireEvent.click(screen.getByTestId("tpl-save-btn"));

		await waitFor(() => {
			expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
		});

		const [payload] = mockCreateTemplate.mock.calls[0]!;
		expect(payload.templateType).toBe("RECEIVABLE");
		expect(payload.name).toBe("Burak Borç Şablonu");

		// Assert exact config keys per Section 60: ONLY personId, description, defaultAmount, dueDate
		const configKeys = Object.keys(payload.config);
		expect(configKeys).toEqual(
			expect.arrayContaining([
				"personId",
				"description",
				"defaultAmount",
				"dueDate",
			]),
		);
		expect(payload.config).not.toHaveProperty("fundingAssetAccountId");
		expect(payload.config).not.toHaveProperty("budgetCategory");
		expect(payload.config).not.toHaveProperty("occurredAt");
	});

	it("executes RECEIVABLE template by opening ObligationForm and prompts for funding asset without calling execute endpoint", async () => {
		const receivableTemplate: QuickEntryTemplateItem = {
			id: "tpl-rec-1",
			userId: "usr-1",
			name: "Burak Borç",
			templateType: "RECEIVABLE",
			status: "ACTIVE",
			sortOrder: 1,
			config: {
				personId: "p1",
				description: "Ödünç",
				defaultAmount: "200.00",
				dueDate: "2026-04-10",
			},
			createdAt: "2026-03-29T10:00:00Z",
			updatedAt: "2026-03-29T10:00:00Z",
		};

		vi.spyOn(quickEntryApi, "fetchQuickEntryTemplates").mockResolvedValue({
			templates: [receivableTemplate],
		});

		vi.spyOn(peopleApi, "fetchAllActivePeople").mockResolvedValue([
			{
				personId: "p1",
				status: "ACTIVE",
				displayName: "Burak",
				relationship: "FRIEND",
				note: null,
				revisionNo: 1,
				receivableBalance: "0.00",
				payableBalance: "0.00",
			},
		]);

		const mockCreateReceivable = vi
			.spyOn(peopleApi, "createPersonReceivable")
			.mockResolvedValue({
				obligation: {
					obligationId: "ob-new",
					personId: "p1",
					direction: "RECEIVABLE",
					status: "OPEN",
					principalAmount: "200.00",
					settledAmount: "0.00",
					remainingAmount: "200.00",
					dueDate: "2026-04-10",
					description: "Ödünç",
					budgetCategory: null,
					revisionNo: 1,
					isSplitManaged: false,
				},
			});

		await renderWithRouter(
			<AppShell>
				<div>Content</div>
			</AppShell>,
		);

		// Tap mobile FAB to open QuickEntrySheet
		const fab = screen.getByTestId("mobile-quick-entry-fab");
		fireEvent.click(fab);

		await waitFor(() => {
			expect(
				screen.getByTestId("quick-template-btn-tpl-rec-1"),
			).toBeInTheDocument();
		});

		// Click template button
		fireEvent.click(screen.getByTestId("quick-template-btn-tpl-rec-1"));

		// Should render ObligationForm prefilled
		await waitFor(() => {
			expect(
				screen.getByTestId("obligation-funding-account-select"),
			).toBeInTheDocument();
		});

		expect(screen.getByTestId("money-input")).toHaveValue("200.00");
		expect(screen.getByDisplayValue("Ödünç")).toBeInTheDocument();

		// Submit canonical POST /people/:personId/obligations/receivable
		fireEvent.click(screen.getByTestId("obligation-submit-btn"));

		await waitFor(() => {
			expect(mockCreateReceivable).toHaveBeenCalledTimes(1);
		});

		expect(mockCreateReceivable).toHaveBeenCalledWith(
			"p1",
			expect.objectContaining({
				amount: "200.00",
				fundingAssetAccountId: "acc-bank",
				description: "Ödünç",
			}),
			expect.any(String),
		);
	});

	it("shows stale person error and blocks execution when template person is missing or archived", async () => {
		const staleTemplate: QuickEntryTemplateItem = {
			id: "tpl-stale",
			userId: "usr-1",
			name: "Eski Kişi Şablonu",
			templateType: "RECEIVABLE",
			status: "ACTIVE",
			sortOrder: 1,
			config: {
				personId: "p-archived",
				description: "Eski borç",
				defaultAmount: "100.00",
			},
			createdAt: "2026-03-29T10:00:00Z",
			updatedAt: "2026-03-29T10:00:00Z",
		};

		vi.spyOn(quickEntryApi, "fetchQuickEntryTemplates").mockResolvedValue({
			templates: [staleTemplate],
		});

		// p-archived is NOT in activePeople
		vi.spyOn(peopleApi, "fetchAllActivePeople").mockResolvedValue([
			{
				personId: "p-other",
				status: "ACTIVE",
				displayName: "Yeni Kişi",
				relationship: "FRIEND",
				note: null,
				revisionNo: 1,
				receivableBalance: "0.00",
				payableBalance: "0.00",
			},
		]);

		const mockCreateReceivable = vi.spyOn(peopleApi, "createPersonReceivable");

		await renderWithRouter(
			<AppShell>
				<div>Content</div>
			</AppShell>,
		);

		// Tap mobile FAB to open QuickEntrySheet
		const fab = screen.getByTestId("mobile-quick-entry-fab");
		fireEvent.click(fab);

		await waitFor(() => {
			expect(
				screen.getByTestId("quick-template-btn-tpl-stale"),
			).toBeInTheDocument();
		});

		fireEvent.click(screen.getByTestId("quick-template-btn-tpl-stale"));

		await waitFor(() => {
			expect(screen.getByTestId("stale-person-warning")).toBeInTheDocument();
		});

		// Assert natural copy per Section 64
		expect(screen.getByTestId("stale-person-warning")).toHaveTextContent(
			"Şablondaki kişi artık kullanılamıyor. Lütfen başka bir kişi seçin.",
		);

		// Must fail closed (no mutation until resolved)
		expect(mockCreateReceivable).not.toHaveBeenCalled();
	});
});

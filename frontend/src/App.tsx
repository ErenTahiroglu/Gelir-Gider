import { QueryClientProvider } from "@tanstack/react-query";
import {
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
	useNavigate,
} from "@tanstack/react-router";
import React, { Suspense, useEffect } from "react";
import { AuthProvider, useAuth } from "./auth/auth-context";
import { AuthGate } from "./components/auth/AuthGate";
import { UnlockScreen } from "./components/auth/UnlockScreen";
import { AppShell } from "./components/layout/AppShell";
import { usePwa } from "./lib/pwa/usePwa";
import { QuerySecurityBoundary } from "./query/QuerySecurityBoundary";
import { queryClient } from "./query/query-client";

// ============================================================================
// Phase F10: Route Loading Fallback & Boundary
// ============================================================================

export function RouteLoadingFallback() {
	return (
		<div
			className="route-loading-boundary"
			role="status"
			aria-label="Yükleniyor…"
		>
			<div className="booting-spinner" aria-hidden="true" />
			<span className="route-loading-text">Yükleniyor…</span>
		</div>
	);
}

// ============================================================================
// Phase F10: Lazy-loaded Domain Boundaries
// ============================================================================

// Dashboard
const DashboardPage = React.lazy(() =>
	import("./components/dashboard/DashboardPage").then((m) => ({
		default: m.DashboardPage,
	})),
);

// Transactions & Manual Expenses
const TransactionsListPage = React.lazy(() =>
	import("./components/transactions/transactions-routes").then((m) => ({
		default: m.TransactionsListPage,
	})),
);
const TransactionDetailPage = React.lazy(() =>
	import("./components/transactions/transactions-routes").then((m) => ({
		default: m.TransactionDetailPage,
	})),
);
const ManualExpenseNewPage = React.lazy(() =>
	import("./components/manual-expenses/manual-expenses-routes").then((m) => ({
		default: m.ManualExpenseNewPage,
	})),
);
const ManualExpenseEditPage = React.lazy(() =>
	import("./components/manual-expenses/manual-expenses-routes").then((m) => ({
		default: m.ManualExpenseEditPage,
	})),
);

// Quick Templates
const TemplateManagement = React.lazy(() =>
	import("./components/quick-entry/TemplateManagement").then((m) => ({
		default: m.TemplateManagement,
	})),
);

// Cards
const CardsPage = React.lazy(() =>
	import("./components/cards/CardsPage").then((m) => ({
		default: m.CardsPage,
	})),
);
const CardNewPage = React.lazy(() =>
	import("./components/cards/card-routes").then((m) => ({
		default: m.CardNewPage,
	})),
);
const CardDetailPage = React.lazy(() =>
	import("./components/cards/card-routes").then((m) => ({
		default: m.CardDetailPageWrapper,
	})),
);
const CardEditPage = React.lazy(() =>
	import("./components/cards/card-routes").then((m) => ({
		default: m.CardEditPage,
	})),
);
const StatementNewPage = React.lazy(() =>
	import("./components/cards/card-routes").then((m) => ({
		default: m.StatementNewPage,
	})),
);
const StatementDetailPage = React.lazy(() =>
	import("./components/cards/card-routes").then((m) => ({
		default: m.StatementDetailPageWrapper,
	})),
);
const PurchaseNewPage = React.lazy(() =>
	import("./components/cards/card-routes").then((m) => ({
		default: m.PurchaseNewPage,
	})),
);
const PurchaseDetailPage = React.lazy(() =>
	import("./components/cards/card-routes").then((m) => ({
		default: m.PurchaseDetailPageWrapper,
	})),
);
const SplitDetailPage = React.lazy(() =>
	import("./components/cards/card-routes").then((m) => ({
		default: m.SplitDetailPageWrapper,
	})),
);

// People
const PeoplePage = React.lazy(() =>
	import("./components/people/PeoplePage").then((m) => ({
		default: m.PeoplePage,
	})),
);
const PersonNewPage = React.lazy(() =>
	import("./components/people/people-routes").then((m) => ({
		default: m.PersonNewPage,
	})),
);
const PersonDetailPage = React.lazy(() =>
	import("./components/people/people-routes").then((m) => ({
		default: m.PersonDetailPageWrapper,
	})),
);
const PersonEditPage = React.lazy(() =>
	import("./components/people/people-routes").then((m) => ({
		default: m.PersonEditPage,
	})),
);
const ObligationNewPage = React.lazy(() =>
	import("./components/people/people-routes").then((m) => ({
		default: m.ObligationNewPage,
	})),
);
const ObligationDetailPage = React.lazy(() =>
	import("./components/people/people-routes").then((m) => ({
		default: m.ObligationDetailPageWrapper,
	})),
);
const PersonSettlePage = React.lazy(() =>
	import("./components/people/people-routes").then((m) => ({
		default: m.PersonSettlePageWrapper,
	})),
);

// Goals
const GoalsPage = React.lazy(() =>
	import("./components/goals/GoalsPage").then((m) => ({
		default: m.GoalsPage,
	})),
);
const GoalNewPage = React.lazy(() =>
	import("./components/goals/goals-routes").then((m) => ({
		default: m.GoalNewPage,
	})),
);
const GoalDetailPage = React.lazy(() =>
	import("./components/goals/goals-routes").then((m) => ({
		default: m.GoalDetailPageWrapper,
	})),
);
const GoalEditPage = React.lazy(() =>
	import("./components/goals/goals-routes").then((m) => ({
		default: m.GoalEditPage,
	})),
);

// Midas
const MidasPage = React.lazy(() =>
	import("./components/midas/MidasPage").then((m) => ({
		default: m.MidasPage,
	})),
);

// Long Term
const LongTermPage = React.lazy(() =>
	import("./components/long-term/LongTermPage").then((m) => ({
		default: m.LongTermPage,
	})),
);
const LongTermNewPage = React.lazy(() =>
	import("./components/long-term/long-term-routes").then((m) => ({
		default: m.LongTermNewPage,
	})),
);
const LongTermDetailPage = React.lazy(() =>
	import("./components/long-term/long-term-routes").then((m) => ({
		default: m.LongTermTaskDetailPageWrapper,
	})),
);

// Income
const IncomePage = React.lazy(() =>
	import("./components/income/IncomePage").then((m) => ({
		default: m.IncomePage,
	})),
);
const IncomeSourceNewPage = React.lazy(() =>
	import("./components/income/income-routes").then((m) => ({
		default: m.IncomeSourceNewPage,
	})),
);
const EntitlementNewPage = React.lazy(() =>
	import("./components/income/income-routes").then((m) => ({
		default: m.EntitlementNewPage,
	})),
);
const EntitlementDetailPage = React.lazy(() =>
	import("./components/income/income-routes").then((m) => ({
		default: m.EntitlementDetailPageWrapper,
	})),
);
const IncomeReceiptNewPage = React.lazy(() =>
	import("./components/income/income-routes").then((m) => ({
		default: m.IncomeReceiptNewPage,
	})),
);
const IncomeReceiptDetailPage = React.lazy(() =>
	import("./components/income/income-routes").then((m) => ({
		default: m.IncomeReceiptDetailPageWrapper,
	})),
);

// Month Close
const MonthClosePage = React.lazy(() =>
	import("./components/month-close/MonthClosePage").then((m) => ({
		default: m.MonthClosePage,
	})),
);
const MonthCloseWizardPage = React.lazy(() =>
	import("./components/month-close/month-close-routes").then((m) => ({
		default: m.MonthCloseWizardPage,
	})),
);
const MonthCloseDetailPage = React.lazy(() =>
	import("./components/month-close/month-close-routes").then((m) => ({
		default: m.MonthCloseDetailPageWrapper,
	})),
);

// Imports
const ImportsPage = React.lazy(() =>
	import("./components/imports/ImportsPage").then((m) => ({
		default: m.ImportsPage,
	})),
);
const ImportBatchPage = React.lazy(() =>
	import("./components/imports/ImportBatchPage").then((m) => ({
		default: m.ImportBatchPage,
	})),
);
const ImportRowsReview = React.lazy(() =>
	import("./components/imports/ImportRowsReview").then((m) => ({
		default: m.ImportRowsReview,
	})),
);

// Notifications
const NotificationsPage = React.lazy(() =>
	import("./components/notifications/NotificationsPage").then((m) => ({
		default: m.NotificationsPage,
	})),
);

function UnlockRouteComponent() {
	const { state } = useAuth();
	const navigate = useNavigate();

	useEffect(() => {
		if (state.status === "UNLOCKED") {
			void navigate({ to: "/" });
		}
	}, [state.status, navigate]);

	if (state.status === "UNLOCKED") {
		return <DashboardPage />;
	}

	return <UnlockScreen />;
}

// ============================================================================
// TanStack Router Configuration with Lazy Routes & Layout Shell
// ============================================================================

const rootRoute = createRootRoute({
	component: () => (
		<AuthGate>
			<AppShell>
				<Suspense fallback={<RouteLoadingFallback />}>
					<Outlet />
				</Suspense>
			</AppShell>
		</AuthGate>
	),
});

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: DashboardPage,
});

const unlockRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/unlock",
	component: UnlockRouteComponent,
});

const transactionsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/transactions",
	component: TransactionsListPage,
});

const transactionsDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/transactions/$transactionId",
	component: TransactionDetailPage,
});

const manualExpenseNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/manual-expenses/new",
	component: ManualExpenseNewPage,
});

const manualExpenseEditRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/manual-expenses/$expenseId/edit",
	component: ManualExpenseEditPage,
});

const templateManagementRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings/quick-templates",
	component: TemplateManagement,
});

const cardsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/cards",
	component: CardsPage,
});

const cardNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/cards/new",
	component: CardNewPage,
});

const cardDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/cards/$cardId",
	component: CardDetailPage,
});

const cardEditRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/cards/$cardId/edit",
	component: CardEditPage,
});

const statementNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/cards/$cardId/statements/new",
	component: StatementNewPage,
});

const statementDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/cards/$cardId/statements/$statementId",
	component: StatementDetailPage,
});

const purchaseNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/cards/$cardId/purchases/new",
	component: PurchaseNewPage,
});

const purchaseDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/cards/$cardId/purchases/$purchaseId",
	component: PurchaseDetailPage,
});

const splitDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/cards/$cardId/purchases/$purchaseId/split",
	component: SplitDetailPage,
});

const peopleRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/people",
	component: PeoplePage,
});

const personNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/people/new",
	component: PersonNewPage,
});

const personDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/people/$personId",
	component: PersonDetailPage,
});

const personEditRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/people/$personId/edit",
	component: PersonEditPage,
});

const obligationNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/people/$personId/obligations/new",
	component: ObligationNewPage,
});

const obligationDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/people/$personId/obligations/$obligationId",
	component: ObligationDetailPage,
});

const personSettleRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/people/$personId/settle",
	component: PersonSettlePage,
});

const goalsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/goals",
	component: GoalsPage,
});

const goalNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/goals/new",
	component: GoalNewPage,
});

const goalDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/goals/$goalId",
	component: GoalDetailPage,
});

const goalEditRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/goals/$goalId/edit",
	component: GoalEditPage,
});

const midasRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/midas",
	component: MidasPage,
});

const longTermRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/long-term",
	component: LongTermPage,
});

const longTermNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/long-term/new",
	component: LongTermNewPage,
});

const longTermDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/long-term/$taskId",
	component: LongTermDetailPage,
});

const incomeRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/income",
	component: IncomePage,
});

const incomeSourceNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/income/sources/new",
	component: IncomeSourceNewPage,
});

const entitlementNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/income/entitlements/new",
	component: EntitlementNewPage,
});

const entitlementDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/income/entitlements/$entitlementId",
	component: EntitlementDetailPage,
});

const incomeReceiptNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/income/receipts/new",
	component: IncomeReceiptNewPage,
});

const receiptDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/income/receipts/$incomeReceiptId",
	component: IncomeReceiptDetailPage,
});

const monthCloseRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/month-close",
	component: MonthClosePage,
});

const monthCloseWizardRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/month-close/wizard",
	component: MonthCloseWizardPage,
});

const monthCloseDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/month-close/$periodMonth",
	component: MonthCloseDetailPage,
});

const importsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/imports",
	component: ImportsPage,
});

const importBatchRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/imports/$batchId",
	component: ImportBatchPage,
});

const importReviewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/imports/$batchId/review",
	component: ImportRowsReview,
});

const notificationsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/notifications",
	component: NotificationsPage,
});

const routeTree = rootRoute.addChildren([
	indexRoute,
	unlockRoute,
	transactionsRoute,
	transactionsDetailRoute,
	manualExpenseNewRoute,
	manualExpenseEditRoute,
	templateManagementRoute,
	cardsRoute,
	cardNewRoute,
	cardDetailRoute,
	cardEditRoute,
	statementNewRoute,
	statementDetailRoute,
	purchaseNewRoute,
	purchaseDetailRoute,
	splitDetailRoute,
	peopleRoute,
	personNewRoute,
	personDetailRoute,
	personEditRoute,
	obligationNewRoute,
	obligationDetailRoute,
	personSettleRoute,
	goalsRoute,
	goalNewRoute,
	goalDetailRoute,
	goalEditRoute,
	midasRoute,
	longTermRoute,
	longTermNewRoute,
	longTermDetailRoute,
	// F8: Income routes
	incomeRoute,
	incomeSourceNewRoute,
	entitlementNewRoute,
	entitlementDetailRoute,
	incomeReceiptNewRoute,
	receiptDetailRoute,
	// F8: Month Close routes (wizard before detail to avoid param match)
	monthCloseRoute,
	monthCloseWizardRoute,
	monthCloseDetailRoute,
	// F9: Imports & Notifications routes
	importsRoute,
	importBatchRoute,
	importReviewRoute,
	notificationsRoute,
]);

export const router = createRouter({
	routeTree,
	defaultPreload: false,
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

function PwaLifecycle() {
	usePwa();
	return null;
}

export function App() {
	return (
		<AuthProvider>
			<PwaLifecycle />
			<QueryClientProvider client={queryClient}>
				<QuerySecurityBoundary>
					<RouterProvider router={router} />
				</QuerySecurityBoundary>
			</QueryClientProvider>
		</AuthProvider>
	);
}

export default App;

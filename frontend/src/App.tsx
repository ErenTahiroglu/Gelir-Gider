import { QueryClientProvider } from "@tanstack/react-query";
import {
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
	useNavigate,
} from "@tanstack/react-router";
import { useEffect } from "react";
import type { PersonObligationDirection } from "./api/people-types";
import { AuthProvider, useAuth } from "./auth/auth-context";
import { AuthGate } from "./components/auth/AuthGate";
import { UnlockScreen } from "./components/auth/UnlockScreen";
import { CardDetailPage } from "./components/cards/CardDetailPage";
import { CardForm } from "./components/cards/CardForm";
import { CardsPage } from "./components/cards/CardsPage";
import { PurchaseDetailPage } from "./components/cards/purchases/PurchaseDetailPage";
import { PurchaseForm } from "./components/cards/purchases/PurchaseForm";
import { SplitDetailPage } from "./components/cards/purchases/SplitDetailPage";
import { StatementDetailPage } from "./components/cards/statements/StatementDetailPage";
import { StatementForm } from "./components/cards/statements/StatementForm";
import { DashboardPage } from "./components/dashboard/DashboardPage";
import { GoalDetailPage } from "./components/goals/GoalDetailPage";
import { GoalForm } from "./components/goals/GoalForm";
import { GoalsPage } from "./components/goals/GoalsPage";
import { EntitlementDetail } from "./components/income/EntitlementDetail";
import { EntitlementForm } from "./components/income/EntitlementForm";
import { IncomePage } from "./components/income/IncomePage";
import { IncomeReceiptDetail } from "./components/income/IncomeReceiptDetail";
import { IncomeReceiptForm } from "./components/income/IncomeReceiptForm";
import { IncomeSourceForm } from "./components/income/IncomeSourceForm";
import { AppShell } from "./components/layout/AppShell";
import { LongTermPage } from "./components/long-term/LongTermPage";
import { LongTermTaskDetailPage } from "./components/long-term/LongTermTaskDetailPage";
import { LongTermTaskForm } from "./components/long-term/LongTermTaskForm";
import { ManualExpenseForm } from "./components/manual-expenses/ManualExpenseForm";
import { MidasPage } from "./components/midas/MidasPage";
import { MonthCloseDetailPage } from "./components/month-close/MonthCloseDetailPage";
import { MonthClosePage } from "./components/month-close/MonthClosePage";
import { MonthCloseWizard } from "./components/month-close/MonthCloseWizard";
import { ObligationDetailPage } from "./components/people/obligations/ObligationDetailPage";
import { ObligationForm } from "./components/people/obligations/ObligationForm";
import { PeoplePage } from "./components/people/PeoplePage";
import { PersonDetailPage } from "./components/people/PersonDetailPage";
import { PersonForm } from "./components/people/PersonForm";
import { PersonSettleReceivablesPage } from "./components/people/settlements/PersonSettleReceivablesPage";
import { TemplateManagement } from "./components/quick-entry/TemplateManagement";
import { TransactionTimeline } from "./components/transactions/TransactionTimeline";
import { QuerySecurityBoundary } from "./query/QuerySecurityBoundary";
import { queryClient } from "./query/query-client";

function AuthenticatedDashboard() {
	return (
		<AppShell>
			<DashboardPage />
		</AppShell>
	);
}

function AuthenticatedTransactions() {
	return (
		<AppShell>
			<TransactionTimeline />
		</AppShell>
	);
}

function AuthenticatedTransactionDetail() {
	const params = transactionsDetailRoute.useParams();
	return (
		<AppShell>
			<TransactionTimeline initialTransactionId={params.transactionId} />
		</AppShell>
	);
}

function AuthenticatedManualExpenseNew() {
	return (
		<AppShell>
			<div className="form-page-container">
				<div className="form-page-card card">
					<h1 className="page-title">Yeni Nakit / Banka Harcaması</h1>
					<ManualExpenseForm mode="create" />
				</div>
			</div>
		</AppShell>
	);
}

function AuthenticatedManualExpenseEdit() {
	const params = manualExpenseEditRoute.useParams();
	return (
		<AppShell>
			<div className="form-page-container">
				<div className="form-page-card card">
					<h1 className="page-title">Harcamayı Düzenle</h1>
					<ManualExpenseForm mode="edit" expenseId={params.expenseId} />
				</div>
			</div>
		</AppShell>
	);
}

function UnlockRouteComponent() {
	const { state } = useAuth();
	const navigate = useNavigate();

	useEffect(() => {
		if (state.status === "UNLOCKED") {
			void navigate({ to: "/" });
		}
	}, [state.status, navigate]);

	if (state.status === "UNLOCKED") {
		return <AuthenticatedDashboard />;
	}

	return <UnlockScreen />;
}

const rootRoute = createRootRoute({
	component: () => (
		<AuthGate>
			<Outlet />
		</AuthGate>
	),
});

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: AuthenticatedDashboard,
});

const unlockRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/unlock",
	component: UnlockRouteComponent,
});

const transactionsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/transactions",
	component: AuthenticatedTransactions,
});

const transactionsDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/transactions/$transactionId",
	component: AuthenticatedTransactionDetail,
});

const manualExpenseNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/manual-expenses/new",
	component: AuthenticatedManualExpenseNew,
});

const manualExpenseEditRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/manual-expenses/$expenseId/edit",
	component: AuthenticatedManualExpenseEdit,
});

function AuthenticatedTemplateManagement() {
	return (
		<AppShell>
			<TemplateManagement />
		</AppShell>
	);
}

const templateManagementRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings/quick-templates",
	component: AuthenticatedTemplateManagement,
});

function AuthenticatedCards() {
	return (
		<AppShell>
			<CardsPage />
		</AppShell>
	);
}

function AuthenticatedCardNew() {
	const navigate = useNavigate();
	return (
		<AppShell>
			<div className="form-page-container">
				<div className="form-page-card card">
					<h1 className="page-title">Yeni Kredi Kartı</h1>
					<CardForm
						mode="create"
						onSuccess={(c) =>
							void navigate({
								to: "/cards/$cardId",
								params: { cardId: c.cardId },
							})
						}
						onCancel={() => void navigate({ to: "/cards" })}
					/>
				</div>
			</div>
		</AppShell>
	);
}

function AuthenticatedCardDetail() {
	const params = cardDetailRoute.useParams();
	return (
		<AppShell>
			<CardDetailPage cardId={params.cardId} />
		</AppShell>
	);
}

function AuthenticatedCardEdit() {
	const params = cardEditRoute.useParams();
	const navigate = useNavigate();
	return (
		<AppShell>
			<div className="form-page-container">
				<div className="form-page-card card">
					<h1 className="page-title">Kartı Düzenle</h1>
					<CardForm
						mode="edit"
						cardId={params.cardId}
						onSuccess={() =>
							void navigate({
								to: "/cards/$cardId",
								params: { cardId: params.cardId },
							})
						}
						onCancel={() =>
							void navigate({
								to: "/cards/$cardId",
								params: { cardId: params.cardId },
							})
						}
					/>
				</div>
			</div>
		</AppShell>
	);
}

function AuthenticatedStatementNew() {
	const params = statementNewRoute.useParams();
	const navigate = useNavigate();
	return (
		<AppShell>
			<div className="form-page-container">
				<div className="form-page-card card">
					<h1 className="page-title">Yeni Ekstre</h1>
					<StatementForm
						mode="create"
						cardId={params.cardId}
						onSuccess={(s) =>
							void navigate({
								to: "/cards/$cardId/statements/$statementId",
								params: { cardId: params.cardId, statementId: s.statementId },
							})
						}
						onCancel={() =>
							void navigate({
								to: "/cards/$cardId",
								params: { cardId: params.cardId },
							})
						}
					/>
				</div>
			</div>
		</AppShell>
	);
}

function AuthenticatedStatementDetail() {
	const params = statementDetailRoute.useParams();
	return (
		<AppShell>
			<StatementDetailPage
				cardId={params.cardId}
				statementId={params.statementId}
			/>
		</AppShell>
	);
}

function AuthenticatedPurchaseNew() {
	const params = purchaseNewRoute.useParams();
	const navigate = useNavigate();
	return (
		<AppShell>
			<div className="form-page-container">
				<div className="form-page-card card">
					<h1 className="page-title">Yeni Kart Harcaması</h1>
					<PurchaseForm
						cardId={params.cardId}
						onSuccess={() =>
							void navigate({
								to: "/cards/$cardId",
								params: { cardId: params.cardId },
							})
						}
						onCancel={() =>
							void navigate({
								to: "/cards/$cardId",
								params: { cardId: params.cardId },
							})
						}
					/>
				</div>
			</div>
		</AppShell>
	);
}

function AuthenticatedPurchaseDetail() {
	const params = purchaseDetailRoute.useParams();
	return (
		<AppShell>
			<PurchaseDetailPage
				cardId={params.cardId}
				purchaseId={params.purchaseId}
			/>
		</AppShell>
	);
}

function AuthenticatedSplitDetail() {
	const params = splitDetailRoute.useParams();
	return (
		<AppShell>
			<SplitDetailPage cardId={params.cardId} purchaseId={params.purchaseId} />
		</AppShell>
	);
}

const cardsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/cards",
	component: AuthenticatedCards,
});

const cardNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/cards/new",
	component: AuthenticatedCardNew,
});

const cardDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/cards/$cardId",
	component: AuthenticatedCardDetail,
});

const cardEditRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/cards/$cardId/edit",
	component: AuthenticatedCardEdit,
});

const statementNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/cards/$cardId/statements/new",
	component: AuthenticatedStatementNew,
});

const statementDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/cards/$cardId/statements/$statementId",
	component: AuthenticatedStatementDetail,
});

const purchaseNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/cards/$cardId/purchases/new",
	component: AuthenticatedPurchaseNew,
});

const purchaseDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/cards/$cardId/purchases/$purchaseId",
	component: AuthenticatedPurchaseDetail,
});

const splitDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/cards/$cardId/purchases/$purchaseId/split",
	component: AuthenticatedSplitDetail,
});

function AuthenticatedPeople() {
	return (
		<AppShell>
			<PeoplePage />
		</AppShell>
	);
}

function AuthenticatedPersonNew() {
	const navigate = useNavigate();
	return (
		<AppShell>
			<div className="form-page-container">
				<div className="form-page-card card">
					<h1 className="page-title">Yeni Kişi Ekle</h1>
					<PersonForm
						mode="create"
						onSuccess={(p) =>
							void navigate({
								to: "/people/$personId",
								params: { personId: p.personId },
							})
						}
						onCancel={() => void navigate({ to: "/people" })}
					/>
				</div>
			</div>
		</AppShell>
	);
}

function AuthenticatedPersonDetail() {
	const params = personDetailRoute.useParams();
	return (
		<AppShell>
			<PersonDetailPage personId={params.personId} />
		</AppShell>
	);
}

function AuthenticatedPersonEdit() {
	const params = personEditRoute.useParams();
	const navigate = useNavigate();
	return (
		<AppShell>
			<div className="form-page-container">
				<div className="form-page-card card">
					<h1 className="page-title">Kişiyi Düzenle</h1>
					<PersonForm
						mode="edit"
						personId={params.personId}
						onSuccess={() =>
							void navigate({
								to: "/people/$personId",
								params: { personId: params.personId },
							})
						}
						onCancel={() =>
							void navigate({
								to: "/people/$personId",
								params: { personId: params.personId },
							})
						}
					/>
				</div>
			</div>
		</AppShell>
	);
}

function AuthenticatedObligationNew() {
	const params = obligationNewRoute.useParams();
	const search = obligationNewRoute.useSearch();
	const navigate = useNavigate();
	return (
		<AppShell>
			<div className="form-page-container">
				<div className="form-page-card card">
					<h1 className="page-title">
						{search?.direction === "PAYABLE"
							? "Yeni Borçlanma Kaydı"
							: "Yeni Borç Verme Kaydı"}
					</h1>
					<ObligationForm
						mode="create"
						personId={params.personId}
						initialDirection={search?.direction ?? "RECEIVABLE"}
						onSuccess={(ob) =>
							void navigate({
								to: "/people/$personId/obligations/$obligationId",
								params: {
									personId: params.personId,
									obligationId: ob.obligationId,
								},
							})
						}
						onCancel={() =>
							void navigate({
								to: "/people/$personId",
								params: { personId: params.personId },
							})
						}
					/>
				</div>
			</div>
		</AppShell>
	);
}

function AuthenticatedObligationDetail() {
	const params = obligationDetailRoute.useParams();
	return (
		<AppShell>
			<ObligationDetailPage
				personId={params.personId}
				obligationId={params.obligationId}
			/>
		</AppShell>
	);
}

function AuthenticatedPersonSettle() {
	const params = personSettleRoute.useParams();
	return (
		<AppShell>
			<PersonSettleReceivablesPage personId={params.personId} />
		</AppShell>
	);
}

const peopleRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/people",
	component: AuthenticatedPeople,
});

const personNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/people/new",
	component: AuthenticatedPersonNew,
});

const personDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/people/$personId",
	component: AuthenticatedPersonDetail,
});

const personEditRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/people/$personId/edit",
	component: AuthenticatedPersonEdit,
});

const obligationNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/people/$personId/obligations/new",
	validateSearch: (
		search: Record<string, unknown>,
	): { direction?: PersonObligationDirection | undefined } => {
		return {
			direction:
				search.direction === "PAYABLE" || search.direction === "RECEIVABLE"
					? search.direction
					: undefined,
		};
	},
	component: AuthenticatedObligationNew,
});

const obligationDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/people/$personId/obligations/$obligationId",
	component: AuthenticatedObligationDetail,
});

const personSettleRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/people/$personId/settle",
	component: AuthenticatedPersonSettle,
});

// ============================================================================
// Phase F7: Goals, Midas & Long-Term Routes
// ============================================================================

function AuthenticatedGoals() {
	return (
		<AppShell>
			<GoalsPage />
		</AppShell>
	);
}

function AuthenticatedGoalNew() {
	return (
		<AppShell>
			<div className="form-page-container">
				<div className="form-page-card card">
					<h1 className="page-title">Yeni Kısa Vadeli Hedef</h1>
					<GoalForm mode="create" />
				</div>
			</div>
		</AppShell>
	);
}

function AuthenticatedGoalDetail() {
	const params = goalDetailRoute.useParams();
	return (
		<AppShell>
			<GoalDetailPage goalId={params.goalId} />
		</AppShell>
	);
}

function AuthenticatedGoalEdit() {
	const params = goalEditRoute.useParams();
	return (
		<AppShell>
			<div className="form-page-container">
				<div className="form-page-card card">
					<h1 className="page-title">Hedefi Düzenle</h1>
					<GoalForm mode="edit" goalId={params.goalId} />
				</div>
			</div>
		</AppShell>
	);
}

function AuthenticatedMidas() {
	return (
		<AppShell>
			<MidasPage />
		</AppShell>
	);
}

function AuthenticatedLongTerm() {
	return (
		<AppShell>
			<LongTermPage />
		</AppShell>
	);
}

function AuthenticatedLongTermNew() {
	return (
		<AppShell>
			<div className="form-page-container">
				<LongTermTaskForm />
			</div>
		</AppShell>
	);
}

function AuthenticatedLongTermDetail() {
	const params = longTermDetailRoute.useParams();
	return (
		<AppShell>
			<LongTermTaskDetailPage taskId={params.taskId} />
		</AppShell>
	);
}

const goalsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/goals",
	component: AuthenticatedGoals,
});

const goalNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/goals/new",
	component: AuthenticatedGoalNew,
});

const goalDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/goals/$goalId",
	component: AuthenticatedGoalDetail,
});

const goalEditRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/goals/$goalId/edit",
	component: AuthenticatedGoalEdit,
});

const midasRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/midas",
	component: AuthenticatedMidas,
});

const longTermRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/long-term",
	component: AuthenticatedLongTerm,
});

const longTermNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/long-term/new",
	component: AuthenticatedLongTermNew,
});

const longTermDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/long-term/$taskId",
	component: AuthenticatedLongTermDetail,
});

// ============================================================================
// Phase F8: Income Routes
// ============================================================================

function AuthenticatedIncome() {
	return (
		<AppShell>
			<IncomePage />
		</AppShell>
	);
}

function AuthenticatedIncomeSourceNew() {
	return (
		<AppShell>
			<IncomeSourceForm />
		</AppShell>
	);
}

function AuthenticatedEntitlementNew() {
	return (
		<AppShell>
			<div className="form-page-container">
				<div className="form-page-card card">
					<h1 className="page-title">Yeni Beklenen Gelir</h1>
					<EntitlementForm />
				</div>
			</div>
		</AppShell>
	);
}

function AuthenticatedEntitlementDetail() {
	const params = entitlementDetailRoute.useParams();
	return (
		<AppShell>
			<EntitlementDetail entitlementId={params.entitlementId} />
		</AppShell>
	);
}

function AuthenticatedReceiptNew() {
	return (
		<AppShell>
			<div className="form-page-container">
				<div className="form-page-card card">
					<h1 className="page-title">Yeni Gelir Tahsilatı</h1>
					<IncomeReceiptForm />
				</div>
			</div>
		</AppShell>
	);
}

function AuthenticatedReceiptDetail() {
	const params = receiptDetailRoute.useParams();
	return (
		<AppShell>
			<IncomeReceiptDetail incomeReceiptId={params.incomeReceiptId} />
		</AppShell>
	);
}

// ============================================================================
// Phase F8: Month Close Routes
// ============================================================================

function AuthenticatedMonthClose() {
	return (
		<AppShell>
			<MonthClosePage />
		</AppShell>
	);
}

function AuthenticatedMonthCloseDetail() {
	const params = monthCloseDetailRoute.useParams();
	return (
		<AppShell>
			<MonthCloseDetailPage periodMonth={params.periodMonth} />
		</AppShell>
	);
}

function AuthenticatedMonthCloseWizard() {
	return (
		<AppShell>
			<MonthCloseWizard />
		</AppShell>
	);
}

const incomeRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/income",
	component: AuthenticatedIncome,
});

const incomeSourceNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/income/sources/new",
	component: AuthenticatedIncomeSourceNew,
});

const entitlementNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/income/entitlements/new",
	component: AuthenticatedEntitlementNew,
});

const entitlementDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/income/entitlements/$entitlementId",
	component: AuthenticatedEntitlementDetail,
});

const receiptNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/income/receipts/new",
	component: AuthenticatedReceiptNew,
});

const receiptDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/income/receipts/$incomeReceiptId",
	component: AuthenticatedReceiptDetail,
});

const monthCloseRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/month-close",
	component: AuthenticatedMonthClose,
});

const monthCloseDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/month-close/$periodMonth",
	component: AuthenticatedMonthCloseDetail,
});

const monthCloseWizardRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/month-close/wizard",
	component: AuthenticatedMonthCloseWizard,
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
	receiptNewRoute,
	receiptDetailRoute,
	// F8: Month Close routes (wizard before detail to avoid param match)
	monthCloseRoute,
	monthCloseWizardRoute,
	monthCloseDetailRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

export function App() {
	return (
		<AuthProvider>
			<QueryClientProvider client={queryClient}>
				<QuerySecurityBoundary>
					<RouterProvider router={router} />
				</QuerySecurityBoundary>
			</QueryClientProvider>
		</AuthProvider>
	);
}

export default App;

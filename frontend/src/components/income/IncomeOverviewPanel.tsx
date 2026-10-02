import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowDownLeft, Calendar, Clock, Plus, TrendingUp } from "lucide-react";
import { useMemo } from "react";
import {
	fetchIncomeEntitlements,
	fetchIncomeReceipts,
	fetchMonthlyReferenceIncome,
} from "../../api/income-api";
import {
	formatPeriodMonthTurkish,
	getIstanbulCalendarDate,
	getIstanbulMonthStartUtcInstant,
	toEntitlementPeriodMonth,
} from "../../lib/istanbul-date";
import {
	formatCentsToCanonical,
	formatMoneyToTry,
	parseMoneyToCents,
} from "../../lib/money";

interface IncomeOverviewPanelProps {
	onSelectTab: (tabKey: string) => void;
}

export function IncomeOverviewPanel({ onSelectTab }: IncomeOverviewPanelProps) {
	const currentIstanbul = getIstanbulCalendarDate();
	const currentPeriodUi = currentIstanbul.periodMonth; // "YYYY-MM"
	const currentPeriodApi = toEntitlementPeriodMonth(currentPeriodUi); // "YYYY-MM-01"
	const startOfMonthInstant = getIstanbulMonthStartUtcInstant(currentPeriodUi);

	// 1. Reference income
	const { data: refIncomeData } = useQuery({
		queryKey: ["income-reference", currentIstanbul.dateString],
		queryFn: () => fetchMonthlyReferenceIncome(currentIstanbul.dateString),
		staleTime: 30_000,
	});

	// 2. Entitlements for this month
	const { data: entitlementsData } = useQuery({
		queryKey: [
			"income-entitlements",
			{ periodMonthFrom: currentPeriodApi, periodMonthUntil: currentPeriodApi },
		],
		queryFn: () =>
			fetchIncomeEntitlements({
				periodMonthFrom: currentPeriodApi,
				periodMonthUntil: currentPeriodApi,
				limit: 100,
			}),
		staleTime: 30_000,
	});

	// 3. Receipts for this month
	const { data: receiptsData } = useQuery({
		queryKey: ["income-receipts", { from: startOfMonthInstant }],
		queryFn: () =>
			fetchIncomeReceipts({
				from: startOfMonthInstant,
				limit: 100,
			}),
		staleTime: 30_000,
	});

	// Calculate sums strictly in BigInt cents
	const currentMonthExpectedCents = useMemo(() => {
		let sum = 0n;
		for (const e of entitlementsData?.entitlements ?? []) {
			if (e.status === "ACTIVE") {
				sum += parseMoneyToCents(e.amount);
			}
		}
		return sum;
	}, [entitlementsData]);

	const currentMonthRealizedCents = useMemo(() => {
		let sum = 0n;
		for (const r of receiptsData?.receipts ?? []) {
			if (r.status === "ACTIVE") {
				sum += parseMoneyToCents(r.amount);
			}
		}
		return sum;
	}, [receiptsData]);

	return (
		<div className="income-overview-panel" data-testid="income-overview-panel">
			<div className="product-grid-3">
				{/* 1. Reference income card */}
				<div className="metric-card">
					<div className="metric-header">
						<span className="metric-title">
							Aylık Referans Gelir
						</span>
						<TrendingUp size={18} className="metric-icon" aria-hidden="true" />
					</div>
					<div className="metric-body">
						<span
							className="metric-value tabular-nums"
							data-testid="overview-reference-total"
						>
							{refIncomeData ? formatMoneyToTry(refIncomeData.total) : "—"}
						</span>
					</div>
					<div className="metric-footer">
						<span className="metric-subtitle">
							Bütçe harcama tavanlarınız için kullanılan temel baz gelir.
						</span>
						<button
							type="button"
							className="btn-link"
							style={{ padding: 0, marginTop: "var(--space-2)", display: "block" }}
							onClick={() => onSelectTab("reference")}
						>
							Detayları ve Yöntemleri Gör →
						</button>
					</div>
				</div>

				{/* 2. Expected income for this month */}
				<div className="metric-card">
					<div className="metric-header">
						<span className="metric-title">
							{formatPeriodMonthTurkish(currentPeriodUi)} Beklenen
						</span>
						<Clock size={18} className="metric-icon" aria-hidden="true" />
					</div>
					<div className="metric-body">
						<span className="metric-value tabular-nums">
							{formatMoneyToTry(
								formatCentsToCanonical(currentMonthExpectedCents),
							)}
						</span>
					</div>
					<div className="metric-footer">
						<span className="metric-subtitle">
							Bu ay için öngörülen düzenli gelirler toplamı (tahakkuk).
						</span>
						<button
							type="button"
							className="btn-link"
							style={{ padding: 0, marginTop: "var(--space-2)", display: "block" }}
							onClick={() => onSelectTab("entitlements")}
						>
							Beklenen Gelirleri Gör →
						</button>
					</div>
				</div>

				{/* 3. Realized cash this month */}
				<div className="metric-card">
					<div className="metric-header">
						<span className="metric-title">
							{formatPeriodMonthTurkish(currentPeriodUi)} Tahsil Edilen
						</span>
						<ArrowDownLeft
							size={18}
							className="metric-icon"
							aria-hidden="true"
						/>
					</div>
					<div className="metric-body">
						<span className="metric-value tabular-nums" style={{ color: "var(--color-success-600)" }}>
							{formatMoneyToTry(
								formatCentsToCanonical(currentMonthRealizedCents),
							)}
						</span>
					</div>
					<div className="metric-footer">
						<span className="metric-subtitle">
							Bu ay kasa ve banka hesaplarınıza fiilen giren toplam nakit.
						</span>
						<button
							type="button"
							className="btn-link"
							style={{ padding: 0, marginTop: "var(--space-2)", display: "block" }}
							onClick={() => onSelectTab("receipts")}
						>
							Tahsilatları Gör →
						</button>
					</div>
				</div>
			</div>

			{/* Quick actions */}
			<div className="card">
				<h3 className="card-title" style={{ marginBottom: "var(--space-3)" }}>Hızlı İşlemler</h3>
				<div className="product-grid-3" style={{ marginBottom: 0 }}>
					<Link
						to="/income/receipts/new"
						className="btn btn-primary"
						style={{ display: "flex", gap: "var(--space-2)" }}
					>
						<ArrowDownLeft size={18} aria-hidden="true" />
						<span>Gelir Girişi Yap</span>
					</Link>
					<Link
						to="/income/entitlements/new"
						className="btn btn-secondary"
						style={{ display: "flex", gap: "var(--space-2)" }}
					>
						<Calendar size={18} aria-hidden="true" />
						<span>Beklenen Gelir Ekle</span>
					</Link>
					<Link
						to="/income/sources/new"
						className="btn btn-secondary"
						style={{ display: "flex", gap: "var(--space-2)" }}
					>
						<Plus size={18} aria-hidden="true" />
						<span>Yeni Gelir Kaynağı</span>
					</Link>
				</div>
			</div>
		</div>
	);
}

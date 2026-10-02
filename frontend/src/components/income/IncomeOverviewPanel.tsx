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
			<div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
				{/* 1. Reference income card */}
				<div className="card p-5 bg-primary/5 border border-primary/20">
					<div className="flex justify-between items-start mb-2">
						<span className="text-xs font-semibold uppercase tracking-wider text-secondary">
							Aylık Referans Gelir
						</span>
						<TrendingUp size={18} className="text-primary" aria-hidden="true" />
					</div>
					<span
						className="text-3xl font-extrabold text-primary block"
						data-testid="overview-reference-total"
					>
						{refIncomeData ? formatMoneyToTry(refIncomeData.total) : "—"}
					</span>
					<p className="text-xs text-secondary mt-2">
						Bütçe harcama tavanlarınız için kullanılan temel baz gelir.
					</p>
					<button
						type="button"
						className="text-xs text-primary font-medium mt-3 block hover:underline"
						onClick={() => onSelectTab("reference")}
					>
						Detayları ve Yöntemleri Gör →
					</button>
				</div>

				{/* 2. Expected income for this month */}
				<div className="card p-5">
					<div className="flex justify-between items-start mb-2">
						<span className="text-xs font-semibold uppercase tracking-wider text-secondary">
							{formatPeriodMonthTurkish(currentPeriodUi)} Beklenen
						</span>
						<Clock size={18} className="text-warning" aria-hidden="true" />
					</div>
					<span className="text-3xl font-extrabold block">
						{formatMoneyToTry(
							formatCentsToCanonical(currentMonthExpectedCents),
						)}
					</span>
					<p className="text-xs text-secondary mt-2">
						Bu ay için öngörülen düzenli gelirler toplamı (tahakkuk).
					</p>
					<button
						type="button"
						className="text-xs text-primary font-medium mt-3 block hover:underline"
						onClick={() => onSelectTab("entitlements")}
					>
						Beklenen Gelirleri Gör →
					</button>
				</div>

				{/* 3. Realized cash this month */}
				<div className="card p-5">
					<div className="flex justify-between items-start mb-2">
						<span className="text-xs font-semibold uppercase tracking-wider text-secondary">
							{formatPeriodMonthTurkish(currentPeriodUi)} Tahsil Edilen
						</span>
						<ArrowDownLeft
							size={18}
							className="text-success"
							aria-hidden="true"
						/>
					</div>
					<span className="text-3xl font-extrabold text-success block">
						{formatMoneyToTry(
							formatCentsToCanonical(currentMonthRealizedCents),
						)}
					</span>
					<p className="text-xs text-secondary mt-2">
						Bu ay kasa ve banka hesaplarınıza fiilen giren toplam nakit.
					</p>
					<button
						type="button"
						className="text-xs text-primary font-medium mt-3 block hover:underline"
						onClick={() => onSelectTab("receipts")}
					>
						Tahsilatları Gör →
					</button>
				</div>
			</div>

			{/* Quick actions */}
			<div className="card p-6 mb-6">
				<h3 className="font-semibold text-lg mb-3">Hızlı İşlemler</h3>
				<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
					<Link
						to="/income/receipts/new"
						className="btn btn-outline-primary flex items-center justify-center gap-2 p-4 text-center"
					>
						<ArrowDownLeft size={18} aria-hidden="true" />
						<span>Gelir Girişi Yap</span>
					</Link>
					<Link
						to="/income/entitlements/new"
						className="btn btn-outline-secondary flex items-center justify-center gap-2 p-4 text-center"
					>
						<Calendar size={18} aria-hidden="true" />
						<span>Beklenen Gelir Ekle</span>
					</Link>
					<Link
						to="/income/sources/new"
						className="btn btn-outline-secondary flex items-center justify-center gap-2 p-4 text-center"
					>
						<Plus size={18} aria-hidden="true" />
						<span>Yeni Gelir Kaynağı</span>
					</Link>
				</div>
			</div>
		</div>
	);
}

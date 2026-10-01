import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, RefreshCw } from "lucide-react";
import { fetchIncomeEntitlements } from "../../api/income-api";
import type { IncomeEntitlementItem } from "../../api/income-types";
import {
	formatPeriodMonthTurkish,
	fromEntitlementPeriodMonth,
} from "../../lib/istanbul-date";
import { formatMoneyToTry } from "../../lib/money";
import { formatSettlementStatusLabel } from "./EntitlementDetail";

export function IncomeEntitlementsPanel() {
	const {
		data,
		isLoading,
		isError,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		refetch,
	} = useInfiniteQuery({
		queryKey: ["income-entitlements"],
		queryFn: ({ pageParam }) =>
			fetchIncomeEntitlements({
				limit: 20,
				...(pageParam
					? {
							beforePeriodMonth: pageParam.beforePeriodMonth,
							beforeEntitlementId: pageParam.beforeEntitlementId,
						}
					: {}),
			}),
		initialPageParam: undefined as
			| { beforePeriodMonth: string; beforeEntitlementId: string }
			| undefined,
		getNextPageParam: (lastPage) => {
			if (lastPage.hasMore && lastPage.nextCursor) {
				return lastPage.nextCursor;
			}
			return undefined;
		},
	});

	const allEntitlements: IncomeEntitlementItem[] =
		data?.pages.flatMap((p) => p.entitlements) ?? [];

	return (
		<div
			className="income-entitlements-panel"
			data-testid="income-entitlements-panel"
		>
			<div className="flex flex-wrap justify-between items-center gap-3 mb-4">
				<div>
					<h2 className="text-xl font-semibold">Beklenen Aylık Gelirler</h2>
					<p className="text-sm text-secondary">
						Aylara göre öngörülen düzenli gelirler ve tahsilat eşleşme
						durumları.
					</p>
				</div>
				<Link
					to="/income/entitlements/new"
					className="btn btn-primary flex items-center gap-1"
					data-testid="btn-new-entitlement"
				>
					<Plus size={16} aria-hidden="true" />
					<span>Yeni Beklenen Gelir</span>
				</Link>
			</div>

			{isLoading ? (
				<div className="card p-6 text-center text-secondary">
					Beklenen gelirler yükleniyor...
				</div>
			) : isError ? (
				<div className="card p-6 text-center text-danger">
					<p>Beklenen gelirler alınırken bir hata oluştu.</p>
					<button
						type="button"
						className="btn btn-secondary mt-2 inline-flex items-center gap-1"
						onClick={() => void refetch()}
					>
						<RefreshCw size={14} aria-hidden="true" />
						<span>Tekrar Dene</span>
					</button>
				</div>
			) : allEntitlements.length === 0 ? (
				<div className="card p-8 text-center text-secondary">
					<p className="mb-3">Kayıtlı beklenen gelir bulunamadı.</p>
					<Link
						to="/income/entitlements/new"
						className="btn btn-outline-primary"
					>
						İlk Beklenen Geliri Ekleyin
					</Link>
				</div>
			) : (
				<>
					{/* Desktop table */}
					<div className="desktop-only table-responsive card mb-4">
						<table className="table" data-testid="entitlements-desktop-table">
							<thead>
								<tr>
									<th>Dönem</th>
									<th>Kaynak</th>
									<th>Beklenen Tutar</th>
									<th>Eşleşen Tutar</th>
									<th>Kalan Açık</th>
									<th>Eşleşme Durumu</th>
									<th>Tahmini Gün</th>
									<th className="text-right">Detay</th>
								</tr>
							</thead>
							<tbody>
								{allEntitlements.map((item) => {
									const isVoided = item.status === "VOIDED";
									const periodUi = fromEntitlementPeriodMonth(item.periodMonth);
									const settlement = formatSettlementStatusLabel(
										item.settlementStatus,
									);
									return (
										<tr
											key={item.entitlementId}
											className={isVoided ? "opacity-60" : ""}
											data-testid={`entitlement-row-${item.entitlementId}`}
										>
											<td className="font-semibold">
												{formatPeriodMonthTurkish(periodUi)}
											</td>
											<td>
												<span className="font-medium block">
													{item.sourceName}
												</span>
												<span className="font-mono text-xs text-secondary">
													{item.sourceCode}
												</span>
											</td>
											<td className="font-bold">
												{formatMoneyToTry(item.amount)}
											</td>
											<td className="text-success font-medium">
												{formatMoneyToTry(item.allocatedAmount)}
											</td>
											<td className="font-medium text-warning">
												{formatMoneyToTry(item.outstandingAmount)}
											</td>
											<td>
												<span className={`badge ${settlement.badgeClass}`}>
													{settlement.label}
												</span>
											</td>
											<td className="text-sm">
												{item.expectedReceiptOn ?? "—"}
												{item.overdue && (
													<span className="text-danger font-semibold block text-xs">
														Gecikti
													</span>
												)}
											</td>
											<td className="text-right">
												<Link
													to="/income/entitlements/$entitlementId"
													params={{ entitlementId: item.entitlementId }}
													className="btn btn-sm btn-ghost"
												>
													İncele
												</Link>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>

					{/* Mobile cards */}
					<div className="mobile-only flex flex-col gap-3 mb-4">
						{allEntitlements.map((item) => {
							const isVoided = item.status === "VOIDED";
							const periodUi = fromEntitlementPeriodMonth(item.periodMonth);
							const settlement = formatSettlementStatusLabel(
								item.settlementStatus,
							);
							return (
								<Link
									key={item.entitlementId}
									to="/income/entitlements/$entitlementId"
									params={{ entitlementId: item.entitlementId }}
									className={`card p-4 block hover:border-primary transition-colors ${isVoided ? "opacity-60" : ""}`}
									data-testid={`entitlement-card-${item.entitlementId}`}
								>
									<div className="flex justify-between items-start gap-2 mb-2">
										<div>
											<span className="font-bold text-base block">
												{formatPeriodMonthTurkish(periodUi)}
											</span>
											<span className="text-xs text-secondary">
												{item.sourceName}
											</span>
										</div>
										<span className={`badge ${settlement.badgeClass}`}>
											{settlement.label}
										</span>
									</div>

									<div className="grid grid-cols-2 gap-2 my-2 text-sm">
										<div>
											<span className="text-xs text-secondary block">
												Beklenen
											</span>
											<span className="font-bold">
												{formatMoneyToTry(item.amount)}
											</span>
										</div>
										<div>
											<span className="text-xs text-secondary block">
												Kalan Açık
											</span>
											<span className="font-bold text-warning">
												{formatMoneyToTry(item.outstandingAmount)}
											</span>
										</div>
									</div>

									{item.expectedReceiptOn && (
										<div className="text-xs text-secondary mt-1">
											Tahmini: {item.expectedReceiptOn}
											{item.overdue && (
												<span className="text-danger font-semibold ml-1">
													(Gecikti)
												</span>
											)}
										</div>
									)}
								</Link>
							);
						})}
					</div>

					{hasNextPage && (
						<div className="text-center mt-4">
							<button
								type="button"
								className="btn btn-secondary"
								onClick={() => void fetchNextPage()}
								disabled={isFetchingNextPage}
							>
								{isFetchingNextPage ? "Yükleniyor..." : "Daha Fazla Göster"}
							</button>
						</div>
					)}
				</>
			)}
		</div>
	);
}

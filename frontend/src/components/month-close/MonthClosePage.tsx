import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarCheck, RefreshCw } from "lucide-react";
import "../../api/domain-errors";
import { fetchMonthCloses } from "../../api/month-close-api";
import type { MonthCloseProductDto } from "../../api/month-close-types";
import {
	formatIstanbulDateTimeTurkish,
	formatPeriodMonthTurkish,
} from "../../lib/istanbul-date";
import { formatMoneyToTry } from "../../lib/money";

export function formatDecisionLabel(
	decision: MonthCloseProductDto["decision"],
): string {
	switch (decision) {
		case "FULL":
			return "Tam Aktarım";
		case "PARTIAL":
			return "Kısmi Aktarım";
		case "SKIP":
			return "Pas Geçildi";
		case "AUTO_MEDIUM":
			return "Orta Vade Rezerv (Otomatik)";
		case "NO_ACTION":
			return "İşlem Yok (Fazlalık Yok)";
		default:
			return decision;
	}
}

export function formatRouteLabel(route: MonthCloseProductDto["route"]): string {
	switch (route) {
		case "SHORT_TERM_GOAL":
			return "Kısa Vadeli Hedef";
		case "MEDIUM_TERM_RESERVE":
			return "Orta Vadeli Rezerv";
		case "NONE":
			return "Yönlendirme Yok";
		default:
			return route;
	}
}

export function MonthClosePage() {
	const {
		data,
		isLoading,
		isError,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		refetch,
	} = useInfiniteQuery({
		queryKey: ["month-closes"],
		queryFn: ({ pageParam }) =>
			fetchMonthCloses({
				limit: 20,
				...(pageParam !== undefined ? { after: pageParam } : {}),
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => {
			if (lastPage.hasMore && lastPage.nextCursor) {
				return lastPage.nextCursor;
			}
			return undefined;
		},
	});

	const allCloses: MonthCloseProductDto[] =
		data?.pages.flatMap((p) => p.monthCloses) ?? [];

	return (
		<div
			className="page-container month-close-page"
			data-testid="month-close-page"
		>
			<div className="page-header">
				<div className="header-title-block">
					<h1 className="page-title">
						<CalendarCheck
							size={26}
							style={{ color: "var(--color-primary-600)" }}
							aria-hidden="true"
						/>
						<span>Ayı Tamamla — Kapanış Geçmişi</span>
					</h1>
					<p className="page-subtitle">
						Tamamlanan dönemlerin muhasebe kapanış özetleri ve fazlalık
						dağıtımları.
					</p>
				</div>
				<div className="header-actions">
					<Link
						to="/month-close/wizard"
						className="btn btn-primary"
						data-testid="btn-open-wizard"
					>
						<CalendarCheck size={18} aria-hidden="true" />
						<span>Ayı Tamamla Sihirbazı</span>
					</Link>
				</div>
			</div>

			{isLoading ? (
				<div
					className="card text-center text-secondary"
					style={{ padding: "var(--space-8)" }}
				>
					Kapanış geçmişi yükleniyor...
				</div>
			) : isError ? (
				<div
					className="card text-center"
					style={{
						padding: "var(--space-8)",
						color: "var(--color-danger-500)",
					}}
				>
					<p>Kapanış kayıtları alınırken bir hata oluştu.</p>
					<button
						type="button"
						className="btn btn-secondary btn-sm"
						style={{ marginTop: "var(--space-2)" }}
						onClick={() => void refetch()}
					>
						<RefreshCw size={14} aria-hidden="true" />
						<span>Tekrar Dene</span>
					</button>
				</div>
			) : allCloses.length === 0 ? (
				<div className="empty-state-card card" data-testid="empty-month-closes">
					<CalendarCheck size={36} aria-hidden="true" className="empty-icon" />
					<h3 className="empty-title">Henüz Tamamlanmış Dönem Yok</h3>
					<p className="empty-message">
						Henüz tamamlanmış bir dönem kapanışı bulunmuyor. Geçmiş ayların
						fazlalıklarını değerlendirmek için sihirbazı başlatın.
					</p>
					<Link
						to="/month-close/wizard"
						className="btn btn-primary"
						style={{ marginTop: "var(--space-2)" }}
					>
						<CalendarCheck size={16} aria-hidden="true" />
						<span>Geçmiş Bir Ayı Tamamlayın</span>
					</Link>
				</div>
			) : (
				<>
					{/* Desktop table */}
					<div className="desktop-only table-responsive card mb-4">
						<table className="table" data-testid="month-closes-desktop-table">
							<thead>
								<tr>
									<th>Dönem</th>
									<th>Referans Gelir</th>
									<th>Kapanış Fazlası</th>
									<th>Dağıtılabilir Tutar</th>
									<th>Yönlendirme & Karar</th>
									<th>Aktarılan Tutar</th>
									<th>Kapanış Tarihi</th>
									<th className="text-right">Detay</th>
								</tr>
							</thead>
							<tbody>
								{allCloses.map((item) => (
									<tr
										key={item.monthCloseId}
										data-testid={`month-close-row-${item.periodMonth}`}
									>
										<td className="font-bold">
											{formatPeriodMonthTurkish(item.periodMonth)}
										</td>
										<td>{formatMoneyToTry(item.referenceIncome)}</td>
										<td className="font-semibold">
											{formatMoneyToTry(item.closeSurplus)}
										</td>
										<td className="font-semibold text-primary">
											{formatMoneyToTry(item.adjustedRoutableSurplus)}
										</td>
										<td>
											<span className="font-medium block">
												{formatRouteLabel(item.route)}
											</span>
											<span className="text-xs text-secondary block">
												{formatDecisionLabel(item.decision)}
											</span>
										</td>
										<td className="font-bold text-success">
											{formatMoneyToTry(item.appliedAmount)}
										</td>
										<td className="text-xs text-secondary">
											{formatIstanbulDateTimeTurkish(item.occurredAt)}
										</td>
										<td className="text-right">
											<Link
												to="/month-close/$periodMonth"
												params={{ periodMonth: item.periodMonth }}
												className="btn btn-sm btn-ghost"
											>
												Özeti Gör
											</Link>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>

					{/* Mobile cards */}
					<div className="mobile-only flex flex-col gap-3 mb-4">
						{allCloses.map((item) => (
							<Link
								key={item.monthCloseId}
								to="/month-close/$periodMonth"
								params={{ periodMonth: item.periodMonth }}
								className="card p-4 block hover:border-primary transition-colors"
								data-testid={`month-close-card-${item.periodMonth}`}
							>
								<div className="flex justify-between items-start mb-2">
									<h3 className="font-bold text-lg">
										{formatPeriodMonthTurkish(item.periodMonth)}
									</h3>
									<span className="badge badge-success">Tamamlandı</span>
								</div>

								<div className="grid grid-cols-2 gap-2 text-sm my-2">
									<div>
										<span className="text-xs text-secondary block">
											Kapanış Fazlası
										</span>
										<span className="font-semibold">
											{formatMoneyToTry(item.closeSurplus)}
										</span>
									</div>
									<div>
										<span className="text-xs text-secondary block">
											Aktarılan Tutar
										</span>
										<span className="font-bold text-success">
											{formatMoneyToTry(item.appliedAmount)}
										</span>
									</div>
								</div>

								<div className="flex justify-between items-center text-xs text-secondary border-t pt-2 mt-2">
									<span>
										{formatRouteLabel(item.route)} (
										{formatDecisionLabel(item.decision)})
									</span>
									<span>{formatIstanbulDateTimeTurkish(item.occurredAt)}</span>
								</div>
							</Link>
						))}
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

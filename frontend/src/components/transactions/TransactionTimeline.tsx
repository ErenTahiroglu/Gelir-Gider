/**
 * Canonical Transaction Timeline Component
 *
 * Adheres strictly to Section 6, 7, 8, 9, 10, 11, 12, 13, 14, 15:
 *   - Authoritative list: GET /transactions
 *   - Keyset infinite pagination with @tanstack/react-query useInfiniteQuery
 *   - Both cursor fields (beforeOccurredAt, beforeTransactionId) sent together
 *   - Status filters: Tümü, Aktif, İptal Edilen
 *   - Kind filter: Nakit / Banka (kind=MANUAL_EXPENSE)
 *   - Europe/Istanbul sticky date grouping (Bugün, Dün, 14 Eylül 2026)
 *   - Mobile: list layout with sticky headers
 *   - Desktop: medium-density table/list hybrid
 *   - Heterogeneous payload safety: getTransactionDisplayModel
 *   - Row click opens transaction detail drawer
 *   - Create button: "Nakit / Banka Harcaması Ekle"
 */

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { fetchSpendingCategories } from "../../api/manual-expenses-api";
import { fetchTransactions } from "../../api/transactions-api";
import type {
	TransactionSummaryItem,
	TransactionsCursor,
} from "../../api/transactions-types";
import { formatTimelineDateGroupTurkish } from "../../lib/istanbul-date";
import { getTransactionDisplayModel } from "../../lib/transaction-display";
import { TransactionDetailDrawer } from "./TransactionDetailDrawer";

export interface TransactionTimelineProps {
	initialTransactionId?: string | null;
}

export function TransactionTimeline({
	initialTransactionId,
}: TransactionTimelineProps) {
	const navigate = useNavigate();

	// Filters
	const [statusFilter, setStatusFilter] = useState<"ALL" | "ACTIVE" | "VOIDED">(
		"ALL",
	);
	const [kindFilter, setKindFilter] = useState<string | undefined>(undefined);

	// Selected transaction for drawer
	const [selectedTxId, setSelectedTxId] = useState<string | null>(
		initialTransactionId ?? null,
	);
	const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(
		!!initialTransactionId,
	);

	// 1. Authoritative Infinite Query
	const {
		data,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		isLoading,
		isError,
		refetch,
	} = useInfiniteQuery({
		queryKey: ["transactions", statusFilter, kindFilter],
		queryFn: async ({ pageParam }) => {
			return fetchTransactions({
				limit: 50,
				status: statusFilter === "ALL" ? undefined : statusFilter,
				kind: kindFilter,
				beforeOccurredAt: pageParam?.beforeOccurredAt,
				beforeTransactionId: pageParam?.beforeTransactionId,
			});
		},
		initialPageParam: undefined as TransactionsCursor | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
	});

	// Supporting reference data for column lookups (categories)
	const { data: categoriesData } = useQuery({
		queryKey: ["spending-categories"],
		queryFn: fetchSpendingCategories,
		staleTime: 60_000,
	});

	// Flatten transactions from all loaded pages
	const transactions: TransactionSummaryItem[] = useMemo(() => {
		if (!data?.pages) return [];
		return data.pages.flatMap((page) => page.transactions);
	}, [data?.pages]);

	// Group transactions by Istanbul date
	const groupedTransactions = useMemo(() => {
		const groups: { dateGroup: string; items: TransactionSummaryItem[] }[] = [];
		let currentGroup: {
			dateGroup: string;
			items: TransactionSummaryItem[];
		} | null = null;

		for (const tx of transactions) {
			const dateGroup = formatTimelineDateGroupTurkish(tx.occurredAt);
			if (!currentGroup || currentGroup.dateGroup !== dateGroup) {
				currentGroup = { dateGroup, items: [tx] };
				groups.push(currentGroup);
			} else {
				currentGroup.items.push(tx);
			}
		}

		return groups;
	}, [transactions]);

	const handleRowClick = (txId: string) => {
		setSelectedTxId(txId);
		setIsDrawerOpen(true);
	};

	const handleCloseDrawer = () => {
		setIsDrawerOpen(false);
		setSelectedTxId(null);
	};

	return (
		<div
			className="transaction-timeline-page"
			data-testid="transaction-timeline"
		>
			{/* Top Bar Actions & Filters */}
			<div className="timeline-header">
				<div className="timeline-title-area">
					<h1 className="page-title">Hareketler</h1>
					<button
						type="button"
						onClick={() => void navigate({ to: "/manual-expenses/new" })}
						className="btn btn-primary btn-sm add-expense-btn"
						data-testid="add-expense-button"
					>
						<Plus size={16} aria-hidden="true" />
						<span>Nakit / Banka Harcaması Ekle</span>
					</button>
				</div>

				{/* Filters Bar */}
				<div className="timeline-filters-bar" data-testid="timeline-filters">
					<fieldset
						className="filter-chips"
						style={{ border: "none", padding: 0, margin: 0 }}
					>
						<legend className="sr-only">Durum Filtresi</legend>
						<button
							type="button"
							onClick={() => setStatusFilter("ALL")}
							className={`filter-chip ${statusFilter === "ALL" ? "active" : ""}`}
							data-testid="filter-all"
						>
							Tümü
						</button>
						<button
							type="button"
							onClick={() => setStatusFilter("ACTIVE")}
							className={`filter-chip ${statusFilter === "ACTIVE" ? "active" : ""}`}
							data-testid="filter-active"
						>
							Aktif
						</button>
						<button
							type="button"
							onClick={() => setStatusFilter("VOIDED")}
							className={`filter-chip ${statusFilter === "VOIDED" ? "active" : ""}`}
							data-testid="filter-voided"
						>
							İptal Edilen
						</button>
					</fieldset>

					<div className="kind-filter-wrapper">
						<select
							value={kindFilter ?? ""}
							onChange={(e) =>
								setKindFilter(e.target.value ? e.target.value : undefined)
							}
							className="form-select form-select-sm"
							aria-label="İşlem Türü Filtresi"
							data-testid="kind-filter-select"
						>
							<option value="">Tüm Türler</option>
							<option value="MANUAL_EXPENSE">Nakit / Banka Harcamaları</option>
						</select>
					</div>
				</div>
			</div>

			{/* Main Content Area */}
			{isLoading ? (
				<div className="timeline-loading" data-testid="timeline-loading">
					<div className="skeleton timeline-skeleton-item" />
					<div className="skeleton timeline-skeleton-item" />
					<div className="skeleton timeline-skeleton-item" />
				</div>
			) : isError ? (
				<div className="timeline-error card" data-testid="timeline-error">
					<p>Hareketler alınamadı.</p>
					<button
						type="button"
						onClick={() => refetch()}
						className="btn btn-secondary btn-sm"
						data-testid="timeline-retry-btn"
					>
						Tekrar Dene
					</button>
				</div>
			) : transactions.length === 0 ? (
				<div className="timeline-empty card" data-testid="timeline-empty">
					<p className="empty-message">Henüz hareket yok.</p>
					<button
						type="button"
						onClick={() => void navigate({ to: "/manual-expenses/new" })}
						className="btn btn-primary"
						data-testid="empty-add-expense-btn"
					>
						<Plus size={16} aria-hidden="true" />
						Nakit / Banka Harcaması Ekle
					</button>
				</div>
			) : (
				<>
					{/* Mobile List View (with sticky date headers) */}
					<div
						className="timeline-mobile-list"
						data-testid="timeline-mobile-list"
					>
						{groupedTransactions.map((group) => (
							<div key={group.dateGroup} className="timeline-date-group">
								<h2 className="sticky-date-heading">{group.dateGroup}</h2>
								<div className="date-group-items">
									{group.items.map((tx) => {
										const display = getTransactionDisplayModel(tx);
										return (
											<button
												key={tx.transactionId}
												type="button"
												onClick={() => handleRowClick(tx.transactionId)}
												className={`timeline-mobile-item ${display.isVoided ? "item-voided" : ""}`}
												data-testid="transaction-row"
												aria-label={`${display.title}, ${display.amountFormatted ?? ""}`}
											>
												<div className="item-main-col">
													<div className="item-title">{display.title}</div>
													<div className="item-meta">
														<span className="item-type-tag">
															{display.typeLabel}
														</span>
														{display.subtitle && (
															<span className="item-subtitle">
																{display.subtitle}
															</span>
														)}
														{display.isVoided && (
															<span className="item-voided-tag">İptal</span>
														)}
													</div>
												</div>
												{display.amountFormatted && (
													<div
														className={`item-amount tone-${display.amountTone} ${display.isVoided ? "amount-voided" : ""}`}
													>
														{display.amountFormatted}
													</div>
												)}
											</button>
										);
									})}
								</div>
							</div>
						))}
					</div>

					{/* Desktop Table View */}
					<div className="timeline-desktop-table-container">
						<table
							className="timeline-desktop-table"
							data-testid="timeline-desktop-table"
						>
							<thead>
								<tr>
									<th scope="col">Tarih</th>
									<th scope="col">Açıklama / İşyeri</th>
									<th scope="col">Tür</th>
									<th scope="col">Kategori</th>
									<th scope="col" style={{ textAlign: "right" }}>
										Tutar
									</th>
									<th scope="col">Durum</th>
								</tr>
							</thead>
							<tbody>
								{transactions.map((tx) => {
									const display = getTransactionDisplayModel(tx);
									const category = categoriesData?.categories.find(
										(c) => c.id === display.spendingCategoryId,
									);

									return (
										<tr
											key={tx.transactionId}
											onClick={() => handleRowClick(tx.transactionId)}
											className={`timeline-table-row ${display.isVoided ? "row-voided" : ""}`}
											data-testid="transaction-table-row"
											tabIndex={0}
											onKeyDown={(e) => {
												if (e.key === "Enter" || e.key === " ") {
													e.preventDefault();
													handleRowClick(tx.transactionId);
												}
											}}
										>
											<td className="cell-date">
												{formatTimelineDateGroupTurkish(tx.occurredAt)}
											</td>
											<td className="cell-title">
												<div className="title-bold">{display.title}</div>
												{display.subtitle && (
													<div className="title-sub">{display.subtitle}</div>
												)}
											</td>
											<td className="cell-kind">{display.typeLabel}</td>
											<td className="cell-category">{category?.name ?? "—"}</td>
											<td
												className={`cell-amount tone-${display.amountTone} ${display.isVoided ? "amount-voided" : ""}`}
												style={{ textAlign: "right" }}
											>
												{display.amountFormatted ?? "—"}
											</td>
											<td className="cell-status">
												{display.isVoided ? (
													<span className="badge badge-voided">İptal</span>
												) : (
													<span className="badge badge-active">Aktif</span>
												)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>

					{/* Load More Button */}
					{hasNextPage && (
						<div className="timeline-load-more">
							<button
								type="button"
								onClick={() => void fetchNextPage()}
								disabled={isFetchingNextPage}
								className="btn btn-secondary load-more-btn"
								data-testid="load-more-btn"
							>
								{isFetchingNextPage ? "Yükleniyor..." : "Daha Fazla Göster"}
							</button>
						</div>
					)}
				</>
			)}

			{/* Detail Drawer */}
			<TransactionDetailDrawer
				transactionId={selectedTxId}
				isOpen={isDrawerOpen}
				onClose={handleCloseDrawer}
			/>
		</div>
	);
}

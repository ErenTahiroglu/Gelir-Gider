import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { AlertCircle, ArrowLeft, Play } from "lucide-react";
import { useState } from "react";
import { getImportBatch, getImportRows } from "../../api/imports-api";
import type { ImportRowDetail, ImportRowStatus } from "../../api/imports-types";
import { formatIstanbulDateTime } from "../../lib/istanbul-date";
import { ImportApplyProgress } from "./ImportApplyProgress";
import { ImportRowResolver } from "./ImportRowResolver";

const STATUS_FILTERS: Array<{ label: string; value: ImportRowStatus | "ALL" }> =
	[
		{ label: "Tümü", value: "ALL" },
		{ label: "Hazır", value: "READY" },
		{ label: "İnceleme Gerekiyor", value: "NEEDS_REVIEW" },
		{ label: "Olası Tekrar", value: "POSSIBLE_DUPLICATE" },
		{ label: "Aynı Kayıt", value: "EXACT_DUPLICATE" },
		{ label: "Uygulandı", value: "APPLIED" },
		{ label: "Mevcut Kayda Bağlandı", value: "LINKED_EXISTING" },
		{ label: "Atlandı", value: "SKIPPED" },
		{ label: "Desteklenmiyor", value: "UNSUPPORTED" },
	];

export function ImportRowsReview() {
	const { batchId } = useParams({ strict: false }) as { batchId: string };
	const navigate = useNavigate();
	const [activeStatus, setActiveStatus] = useState<ImportRowStatus | "ALL">(
		"ALL",
	);
	const [selectedRow, setSelectedRow] = useState<ImportRowDetail | null>(null);
	const [isApplying, setIsApplying] = useState(false);

	const batchQuery = useQuery({
		queryKey: ["import-batch", batchId],
		queryFn: () => getImportBatch(batchId),
		enabled: !!batchId,
	});

	const rowsQuery = useInfiniteQuery({
		queryKey: [
			"import-rows",
			batchId,
			activeStatus === "ALL" ? undefined : activeStatus,
		],
		queryFn: ({ pageParam }) =>
			getImportRows({
				batchId,
				limit: 50,
				...(activeStatus !== "ALL" ? { status: activeStatus } : {}),
				...(pageParam ? { after: pageParam } : {}),
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		enabled: !!batchId,
	});

	const batch = batchQuery.data;
	const allRows = rowsQuery.data?.pages.flatMap((page) => page.items) ?? [];

	return (
		<div
			className="page-container import-review-page"
			data-testid="import-review-page"
		>
			<div className="page-header">
				<div className="page-header-back">
					<button
						type="button"
						className="btn btn-icon"
						onClick={() =>
							void navigate({
								to: "/imports/$batchId",
								params: { batchId },
							})
						}
						aria-label="Özete Dön"
					>
						<ArrowLeft size={20} aria-hidden="true" />
					</button>
					<div>
						<h1 className="page-title">Satır İnceleme & Eşleme</h1>
						<span className="page-subtitle">
							{batch?.sourceFileName || "Ekstre İçe Aktarma"} (Toplam{" "}
							{batch?.totalRows ?? 0} satır)
						</span>
					</div>
				</div>

				<div className="page-actions">
					{batch && batch.readyCount > 0 && (
						<button
							type="button"
							className="btn btn-primary"
							onClick={() => setIsApplying(true)}
							data-testid="btn-apply-ready-from-review"
						>
							<Play size={16} aria-hidden="true" />
							Hazır Satırları Uygula ({batch.readyCount})
						</button>
					)}
				</div>
			</div>

			{/* Status Filter Tabs */}
			<div
				className="filter-tabs-container"
				role="tablist"
				aria-label="Satır Durum Filtresi"
			>
				{STATUS_FILTERS.map((filter) => {
					const isActive = activeStatus === filter.value;
					return (
						<button
							key={filter.value}
							type="button"
							role="tab"
							aria-selected={isActive}
							className={`filter-tab ${isActive ? "active" : ""}`}
							onClick={() => setActiveStatus(filter.value)}
							data-testid={`filter-tab-${filter.value.toLowerCase()}`}
						>
							{filter.label}
						</button>
					);
				})}
			</div>

			{/* Rows Table */}
			{rowsQuery.isLoading ? (
				<div className="loading-state" data-testid="rows-loading">
					Satırlar yükleniyor...
				</div>
			) : allRows.length === 0 ? (
				<div className="empty-state card" data-testid="empty-rows-message">
					<p>Bu filtreye uygun satır bulunamadı.</p>
				</div>
			) : (
				<div className="review-table-container">
					<div className="table-responsive">
						<table
							className="import-rows-table"
							data-testid="review-rows-table"
						>
							<thead>
								<tr>
									<th>#</th>
									<th>Tür</th>
									<th>Tarih</th>
									<th>Açıklama / Detay</th>
									<th>Tutar</th>
									<th>Aday / Durum</th>
									<th>İşlem</th>
								</tr>
							</thead>
							<tbody>
								{allRows.map((row) => {
									const isCard = row.recordType === "CREDIT_CARD_PURCHASE";
									const isIncome = row.recordType === "INCOME_RECEIPT";
									const cardPayload = isCard
										? (row.payload as {
												merchant?: string;
												description?: string;
												cardId?: string;
												purchaseCategory?: string;
											})
										: null;
									const incomePayload = isIncome
										? (row.payload as {
												note?: string;
												incomeSourceId?: string;
												destinationAccountId?: string;
											})
										: null;

									return (
										<tr
											key={row.id}
											data-testid={`review-row-${row.id}`}
											className={`row-status-${row.status.toLowerCase()}`}
										>
											<td>{row.rowOrdinal}</td>
											<td>
												<span className="type-badge">{row.recordType}</span>
											</td>
											<td>
												{row.occurredAt
													? formatIstanbulDateTime(row.occurredAt)
													: "-"}
											</td>
											<td>
												<div className="row-detail-cell">
													{isCard && (
														<>
															<strong>
																{cardPayload?.merchant ||
																	cardPayload?.description ||
																	"Kart Harcaması"}
															</strong>
															{cardPayload?.purchaseCategory && (
																<span className="category-subtext">
																	Kategori: {cardPayload.purchaseCategory}
																</span>
															)}
														</>
													)}
													{isIncome && (
														<>
															<strong>
																{incomePayload?.note || "Gelir Kaydı"}
															</strong>
														</>
													)}
													{row.recordType === "UNSUPPORTED" && (
														<span className="text-muted">
															Desteklenmeyen kayıt yapısı
														</span>
													)}
												</div>
											</td>
											<td>
												{row.payload && "amount" in row.payload
													? `${(row.payload as { amount: string }).amount} ₺`
													: "-"}
											</td>
											<td>
												<div className="status-col">
													<span
														className={`status-pill status-${row.status.toLowerCase()}`}
														data-testid={`row-status-pill-${row.id}`}
													>
														{row.status}
													</span>
													{row.duplicateCandidates.length > 0 && (
														<span
															className="candidate-warning"
															title={`${row.duplicateCandidates.length} tekrar adayı bulundu`}
														>
															<AlertCircle size={14} aria-hidden="true" />
															{row.duplicateCandidates.length} aday
														</span>
													)}
												</div>
											</td>
											<td>
												{row.status !== "EXACT_DUPLICATE" &&
												row.status !== "APPLIED" &&
												row.status !== "LINKED_EXISTING" &&
												row.status !== "SKIPPED" &&
												row.status !== "UNSUPPORTED" ? (
													<button
														type="button"
														className="btn btn-xs btn-outline"
														onClick={() => setSelectedRow(row)}
														data-testid={`btn-resolve-row-${row.id}`}
													>
														Çözümle
													</button>
												) : (
													<button
														type="button"
														className="btn btn-xs btn-ghost"
														onClick={() => setSelectedRow(row)}
														data-testid={`btn-view-row-${row.id}`}
													>
														Görüntüle
													</button>
												)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>

					{rowsQuery.hasNextPage && (
						<div className="pagination-actions">
							<button
								type="button"
								className="btn btn-secondary"
								onClick={() => void rowsQuery.fetchNextPage()}
								disabled={rowsQuery.isFetchingNextPage}
								data-testid="btn-load-more-rows"
							>
								{rowsQuery.isFetchingNextPage
									? "Yükleniyor..."
									: "Daha Fazla Satır Yükle"}
							</button>
						</div>
					)}
				</div>
			)}

			{/* Row Resolver Modal */}
			{selectedRow && (
				<ImportRowResolver
					row={selectedRow}
					isOpen={!!selectedRow}
					onClose={() => setSelectedRow(null)}
				/>
			)}

			{/* Chunk Apply Modal */}
			{isApplying && batch && (
				<ImportApplyProgress
					batchId={batch.id}
					isOpen={isApplying}
					onClose={() => setIsApplying(false)}
				/>
			)}
		</div>
	);
}

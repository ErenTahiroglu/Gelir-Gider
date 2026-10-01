import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Play, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { getImportBatch, getImportBatchPreview } from "../../api/imports-api";
import type { ImportRowDetail } from "../../api/imports-types";
import { formatIstanbulDateTime } from "../../lib/istanbul-date";
import { ImportApplyProgress } from "./ImportApplyProgress";
import { ImportRowResolver } from "./ImportRowResolver";

export function ImportBatchPage() {
	const { batchId } = useParams({ strict: false }) as { batchId: string };
	const navigate = useNavigate();
	const [selectedRow, setSelectedRow] = useState<ImportRowDetail | null>(null);
	const [isApplying, setIsApplying] = useState(false);

	const batchQuery = useQuery({
		queryKey: ["import-batch", batchId],
		queryFn: () => getImportBatch(batchId),
		enabled: !!batchId,
	});

	const previewQuery = useQuery({
		queryKey: ["import-preview", batchId],
		queryFn: () => getImportBatchPreview(batchId),
		enabled: !!batchId,
	});

	const batch = batchQuery.data;
	const preview = previewQuery.data;

	if (batchQuery.isLoading || previewQuery.isLoading) {
		return (
			<div className="page-container">
				<div className="loading-state" data-testid="batch-loading">
					Yükleniyor...
				</div>
			</div>
		);
	}

	if (batchQuery.isError || !batch) {
		return (
			<div className="page-container">
				<div className="error-card" role="alert">
					<h3>Ekstre Yüklemesi Bulunamadı</h3>
					<p>İstenen içe aktarma kaydı mevcut değil veya bir hata oluştu.</p>
					<Link to="/imports" className="btn btn-secondary">
						İçe Aktarma Listesine Dön
					</Link>
				</div>
			</div>
		);
	}

	return (
		<div
			className="page-container import-batch-page"
			data-testid="import-batch-page"
		>
			<div className="page-header">
				<div className="page-header-back">
					<button
						type="button"
						className="btn btn-icon"
						onClick={() => void navigate({ to: "/imports" })}
						aria-label="Geri Dön"
					>
						<ArrowLeft size={20} aria-hidden="true" />
					</button>
					<div>
						<h1 className="page-title">
							{batch.sourceFileName || "Ekstre İçe Aktarma"}
						</h1>
						<span className="page-subtitle">
							Yüklenme: {formatIstanbulDateTime(batch.createdAt)}
						</span>
					</div>
				</div>

				<div className="page-actions">
					<Link
						to="/imports/$batchId/review"
						params={{ batchId: batch.id }}
						className="btn btn-secondary"
						data-testid="btn-review-all-rows"
					>
						<SlidersHorizontal size={16} aria-hidden="true" />
						Tüm Satırları İncele ({batch.totalRows})
					</Link>

					{batch.readyCount > 0 && (
						<button
							type="button"
							className="btn btn-primary"
							onClick={() => setIsApplying(true)}
							data-testid="btn-apply-ready"
						>
							<Play size={16} aria-hidden="true" />
							Hazır Satırları Uygula ({batch.readyCount})
						</button>
					)}
				</div>
			</div>

			{/* Batch Summary Counters */}
			<div className="import-status-grid" data-testid="batch-summary-grid">
				<div className="status-metric-card total">
					<span className="metric-label">Toplam Satır</span>
					<span className="metric-value">{batch.totalRows}</span>
				</div>
				<div className="status-metric-card ready">
					<span className="metric-label">Hazır</span>
					<span className="metric-value">{batch.readyCount}</span>
				</div>
				<div className="status-metric-card review">
					<span className="metric-label">İnceleme Gerekiyor</span>
					<span className="metric-value">{batch.needsReviewCount}</span>
				</div>
				<div className="status-metric-card possible-dup">
					<span className="metric-label">Olası Tekrar</span>
					<span className="metric-value">{batch.possibleDuplicateCount}</span>
				</div>
				<div className="status-metric-card exact-dup">
					<span className="metric-label">Aynı Kayıt</span>
					<span className="metric-value">{batch.exactDuplicateCount}</span>
				</div>
				<div className="status-metric-card applied">
					<span className="metric-label">Uygulandı</span>
					<span className="metric-value">{batch.appliedCount}</span>
				</div>
				<div className="status-metric-card linked">
					<span className="metric-label">Bağlandı</span>
					<span className="metric-value">{batch.linkedCount}</span>
				</div>
				<div className="status-metric-card skipped">
					<span className="metric-label">Atlandı</span>
					<span className="metric-value">{batch.skippedCount}</span>
				</div>
				<div className="status-metric-card unsupported">
					<span className="metric-label">Desteklenmiyor</span>
					<span className="metric-value">{batch.unsupportedCount}</span>
				</div>
			</div>

			{/* Batch Metadata Info */}
			<div className="batch-meta-card card">
				<div className="meta-row">
					<span className="meta-label">Kaynak Türü:</span>
					<span className="meta-val">{batch.sourceKind}</span>
				</div>
				<div className="meta-row">
					<span className="meta-label">Ayrıştırıcı:</span>
					<span className="meta-val">
						{batch.parserType} (v{batch.parserVersion})
					</span>
				</div>
				<div className="meta-row">
					<span className="meta-label">Gözlemlenme Zamanı:</span>
					<span className="meta-val">
						{formatIstanbulDateTime(batch.observedAt)}
					</span>
				</div>
			</div>

			{/* Sample Preview Section */}
			<div className="preview-section">
				<div className="section-header">
					<div>
						<h2 className="section-title">Önizleme Örneği</h2>
						<span
							className="preview-sample-label"
							data-testid="preview-sample-label"
						>
							{batch.totalRows > 25
								? `İlk ${preview?.rowSampleLimit ?? 25} satırdan örnek (Toplam ${batch.totalRows} satır)`
								: `Tüm satırlar (${batch.totalRows} satır)`}
						</span>
					</div>
					<Link
						to="/imports/$batchId/review"
						params={{ batchId: batch.id }}
						className="btn btn-sm btn-outline"
					>
						Tüm Satırları Gör
					</Link>
				</div>

				<div className="table-responsive">
					<table className="import-rows-table" data-testid="preview-rows-table">
						<thead>
							<tr>
								<th>#</th>
								<th>Tür</th>
								<th>Tarih</th>
								<th>Açıklama / Detay</th>
								<th>Tutar</th>
								<th>Durum</th>
								<th>İşlem</th>
							</tr>
						</thead>
						<tbody>
							{preview?.rowSample.map((row) => (
								<tr key={row.id} data-testid={`preview-row-${row.id}`}>
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
											{row.recordType === "CREDIT_CARD_PURCHASE" && (
												<span>
													{(row.payload as { merchant?: string }).merchant ||
														(row.payload as { description?: string })
															.description ||
														"-"}
												</span>
											)}
											{row.recordType === "INCOME_RECEIPT" && (
												<span>
													{(row.payload as { note?: string }).note ||
														"Gelir Kaydı"}
												</span>
											)}
											{row.recordType === "UNSUPPORTED" && (
												<span className="text-muted">
													Desteklenmeyen satır yapısı
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
										<span
											className={`status-pill status-${row.status.toLowerCase()}`}
											data-testid={`row-status-${row.id}`}
										>
											{row.status}
										</span>
									</td>
									<td>
										{row.status !== "EXACT_DUPLICATE" &&
											row.status !== "APPLIED" &&
											row.status !== "LINKED_EXISTING" &&
											row.status !== "SKIPPED" &&
											row.status !== "UNSUPPORTED" && (
												<button
													type="button"
													className="btn btn-xs btn-outline"
													onClick={() => setSelectedRow(row)}
													data-testid={`btn-resolve-row-${row.id}`}
												>
													Çözümle
												</button>
											)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>

			{/* Row Resolver Modal */}
			{selectedRow && (
				<ImportRowResolver
					row={selectedRow}
					isOpen={!!selectedRow}
					onClose={() => setSelectedRow(null)}
				/>
			)}

			{/* Chunk Apply Modal */}
			{isApplying && (
				<ImportApplyProgress
					batchId={batch.id}
					readyCount={batch.readyCount}
					isOpen={isApplying}
					onClose={() => setIsApplying(false)}
				/>
			)}
		</div>
	);
}

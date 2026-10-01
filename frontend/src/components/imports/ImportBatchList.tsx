import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	AlertTriangle,
	CheckCircle2,
	ChevronRight,
	Clock,
	Copy,
	FileSpreadsheet,
	HelpCircle,
	MinusCircle,
	XCircle,
} from "lucide-react";
import { getImportBatches } from "../../api/imports-api";
import type { ImportBatchSummary } from "../../api/imports-types";
import { formatIstanbulDateTime } from "../../lib/istanbul-date";

export function ImportBatchList() {
	const {
		data,
		isLoading,
		isError,
		error,
		hasNextPage,
		fetchNextPage,
		isFetchingNextPage,
	} = useInfiniteQuery({
		queryKey: ["import-batches"],
		queryFn: ({ pageParam }) =>
			getImportBatches({
				limit: 50,
				...(pageParam ? { after: pageParam } : {}),
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
	});

	const batches: ImportBatchSummary[] =
		data?.pages.flatMap((page) => page.items) ?? [];

	if (isLoading) {
		return (
			<div className="card loading-card" data-testid="batches-loading">
				<p>İçe aktarma geçmişi yükleniyor...</p>
			</div>
		);
	}

	if (isError) {
		return (
			<div className="card error-card" role="alert" data-testid="batches-error">
				<p>
					{error instanceof Error
						? error.message
						: "İçe aktarma geçmişi yüklenemedi."}
				</p>
			</div>
		);
	}

	if (batches.length === 0) {
		return (
			<div className="card empty-state-card" data-testid="batches-empty">
				<FileSpreadsheet size={40} className="empty-icon" aria-hidden="true" />
				<h3>Henüz İçe Aktarma Yapılmadı</h3>
				<p>Yukarıdaki formu kullanarak ilk CSV ekstrenizi yükleyebilirsiniz.</p>
			</div>
		);
	}

	return (
		<div className="batch-list-container" data-testid="batch-list-container">
			<h2 className="section-title">İçe Aktarma Geçmişi</h2>
			<div className="batch-cards-grid">
				{batches.map((batch) => (
					<Link
						key={batch.id}
						to="/imports/$batchId"
						params={{ batchId: batch.id }}
						className="batch-card card hoverable"
						data-testid={`batch-card-${batch.id}`}
					>
						<div className="batch-card-header">
							<div className="batch-file-info">
								<FileSpreadsheet
									size={20}
									className="batch-icon"
									aria-hidden="true"
								/>
								<span className="batch-file-name">
									{batch.sourceFileName || "İsimsiz Ekstre Dosyası"}
								</span>
							</div>
							<ChevronRight
								size={18}
								className="chevron-icon"
								aria-hidden="true"
							/>
						</div>

						<div className="batch-meta-row">
							<span className="meta-item">
								<Clock size={14} aria-hidden="true" />
								<span>{formatIstanbulDateTime(batch.createdAt)}</span>
							</span>
							<span className="meta-item total-badge">
								Toplam {batch.totalRows} Satır
							</span>
						</div>

						<div className="batch-counts-grid">
							{batch.readyCount > 0 && (
								<div className="count-tag ready" title="Uygulanmaya Hazır">
									<CheckCircle2 size={12} aria-hidden="true" />
									<span>{batch.readyCount} Hazır</span>
								</div>
							)}
							{batch.needsReviewCount > 0 && (
								<div
									className="count-tag review"
									title="Eşleştirme / İnceleme Gerekiyor"
								>
									<HelpCircle size={12} aria-hidden="true" />
									<span>{batch.needsReviewCount} İnceleme</span>
								</div>
							)}
							{batch.possibleDuplicateCount > 0 && (
								<div className="count-tag possible-dup" title="Olası Tekrar">
									<AlertTriangle size={12} aria-hidden="true" />
									<span>{batch.possibleDuplicateCount} Olası Tekrar</span>
								</div>
							)}
							{batch.exactDuplicateCount > 0 && (
								<div className="count-tag exact-dup" title="Aynı Kayıt">
									<Copy size={12} aria-hidden="true" />
									<span>{batch.exactDuplicateCount} Aynı Kayıt</span>
								</div>
							)}
							{batch.appliedCount > 0 && (
								<div className="count-tag applied" title="Uygulandı">
									<CheckCircle2 size={12} aria-hidden="true" />
									<span>{batch.appliedCount} Uygulandı</span>
								</div>
							)}
							{batch.linkedCount > 0 && (
								<div className="count-tag linked" title="Mevcut Kayda Bağlandı">
									<CheckCircle2 size={12} aria-hidden="true" />
									<span>{batch.linkedCount} Bağlandı</span>
								</div>
							)}
							{batch.skippedCount > 0 && (
								<div className="count-tag skipped" title="Atlandı">
									<MinusCircle size={12} aria-hidden="true" />
									<span>{batch.skippedCount} Atlandı</span>
								</div>
							)}
							{batch.unsupportedCount > 0 && (
								<div className="count-tag unsupported" title="Desteklenmiyor">
									<XCircle size={12} aria-hidden="true" />
									<span>{batch.unsupportedCount} Desteklenmiyor</span>
								</div>
							)}
						</div>
					</Link>
				))}
			</div>

			{hasNextPage && (
				<div className="load-more-container">
					<button
						type="button"
						className="btn btn-secondary"
						onClick={() => void fetchNextPage()}
						disabled={isFetchingNextPage}
						data-testid="btn-load-more-batches"
					>
						{isFetchingNextPage ? "Yükleniyor..." : "Daha Fazla Göster"}
					</button>
				</div>
			)}
		</div>
	);
}

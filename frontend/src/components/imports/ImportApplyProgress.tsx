import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { isNetworkUncertainError } from "../../api/errors";
import { applyReadyImportRows, getImportBatch } from "../../api/imports-api";
import { AccessibleModal } from "../common/AccessibleModal";

interface ImportApplyProgressProps {
	batchId: string;
	readyCount?: number;
	isOpen: boolean;
	onClose: () => void;
	onComplete?: () => void;
}

export function ImportApplyProgress({
	batchId,
	readyCount = 0,
	isOpen,
	onClose,
	onComplete,
}: ImportApplyProgressProps) {
	const queryClient = useQueryClient();

	const [isApplying, setIsApplying] = useState(false);
	const [totalAppliedSoFar, setTotalAppliedSoFar] = useState(0);
	const [remainingReady, setRemainingReady] = useState(readyCount);
	const [statusMessage, setStatusMessage] = useState<string | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [hasFailedRows, setHasFailedRows] = useState(false);
	const [isDone, setIsDone] = useState(false);
	const [isNetworkUncertain, setIsNetworkUncertain] = useState(false);

	const invalidateFinancialQueries = async () => {
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: ["import-batches"] }),
			queryClient.invalidateQueries({ queryKey: ["import-batch", batchId] }),
			queryClient.invalidateQueries({ queryKey: ["import-preview", batchId] }),
			queryClient.invalidateQueries({ queryKey: ["import-rows", batchId] }),
			queryClient.invalidateQueries({ queryKey: ["transactions"] }),
			queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] }),
			queryClient.invalidateQueries({ queryKey: ["credit-cards"] }),
			queryClient.invalidateQueries({ queryKey: ["active-credit-cards"] }),
			queryClient.invalidateQueries({ queryKey: ["card-purchases"] }),
			queryClient.invalidateQueries({ queryKey: ["spending-summary"] }),
			queryClient.invalidateQueries({ queryKey: ["income-receipts"] }),
			queryClient.invalidateQueries({ queryKey: ["income-reference"] }),
			queryClient.invalidateQueries({ queryKey: ["month-close-preview"] }),
			queryClient.invalidateQueries({ queryKey: ["budget-checkpoints"] }),
		]);
	};

	const startApplyLoop = async () => {
		setIsApplying(true);
		setErrorMessage(null);
		setHasFailedRows(false);
		setIsDone(false);
		setIsNetworkUncertain(false);
		setStatusMessage("Hazır satırlar sisteme aktarılıyor...");

		let currentAppliedTotal = totalAppliedSoFar;
		let localHasFailed = false;

		try {
			let hasMore = true;
			while (hasMore) {
				const response = await applyReadyImportRows(batchId, 50);

				currentAppliedTotal += response.appliedCount;
				setTotalAppliedSoFar(currentAppliedTotal);
				setRemainingReady(response.remainingReadyCount);

				// If any row failed, stop loop immediately (Section 48)
				if (response.failedCount > 0) {
					localHasFailed = true;
					setHasFailedRows(true);
					setStatusMessage("Bazı satırlar uygulanamadı. İnceleme gerekiyor.");
					hasMore = false;
					break;
				}

				// Zero-progress safety guard (Section 48)
				if (response.hasMore && response.appliedCount === 0) {
					localHasFailed = true;
					setHasFailedRows(true);
					setStatusMessage("İlerleme sağlanamadı. Lütfen satırları inceleyin.");
					hasMore = false;
					break;
				}

				hasMore = response.hasMore;
			}

			await invalidateFinancialQueries();

			if (!localHasFailed) {
				setIsDone(true);
				setStatusMessage("Tüm hazır satırlar başarıyla sisteme aktarıldı.");
				onComplete?.();
			}
		} catch (err) {
			if (isNetworkUncertainError(err)) {
				setIsNetworkUncertain(true);
				setStatusMessage(
					"Ağ bağlantısı kesildi. Güncel durum sunucudan kontrol ediliyor...",
				);
				// Section 49: Immediately refetch batch from server authority
				try {
					const freshBatch = await getImportBatch(batchId);
					setRemainingReady(freshBatch.readyCount);
					setTotalAppliedSoFar(freshBatch.appliedCount);
					await invalidateFinancialQueries();
					setErrorMessage(
						"Ağ hatası nedeniyle işlem durduruldu. Güncel durum sunucudan senkronize edildi. Kalan hazır satırları uygulamaya devam edebilirsiniz.",
					);
				} catch {
					setErrorMessage("Ağ hatası oluştu ve sunucu durumu doğrulanamadı.");
				}
			} else {
				setErrorMessage(
					err instanceof Error
						? err.message
						: "Satırlar uygulanırken bir hata oluştu.",
				);
			}
		} finally {
			setIsApplying(false);
		}
	};

	return (
		<AccessibleModal
			isOpen={isOpen}
			onClose={() => {
				if (!isApplying) {
					onClose();
				}
			}}
			title="Hazır Satırları Uygula"
			className="apply-progress-modal"
		>
			<div
				className="apply-progress-content"
				data-testid="apply-progress-dialog"
			>
				<div className="apply-status-header">
					{isApplying ? (
						<Loader2
							size={32}
							className="spin text-primary"
							aria-hidden="true"
						/>
					) : isDone ? (
						<CheckCircle2
							size={32}
							className="text-success"
							aria-hidden="true"
						/>
					) : hasFailedRows || errorMessage ? (
						<AlertCircle
							size={32}
							className="text-warning"
							aria-hidden="true"
						/>
					) : (
						<RefreshCw size={32} className="text-primary" aria-hidden="true" />
					)}

					<p
						className="apply-status-message"
						data-testid="apply-status-message"
					>
						{statusMessage ||
							`${readyCount} adet hazır satır finansal kayıtlara aktarılacak.`}
					</p>
				</div>

				<div className="progress-metrics-bar">
					<div className="metric-pill">
						<span className="metric-label">Uygulanan</span>
						<span className="metric-value" data-testid="metric-applied-count">
							{totalAppliedSoFar}
						</span>
					</div>
					<div className="metric-pill">
						<span className="metric-label">Kalan Hazır</span>
						<span className="metric-value" data-testid="metric-remaining-count">
							{remainingReady}
						</span>
					</div>
				</div>

				{errorMessage && (
					<div
						className="form-error-banner"
						role="alert"
						data-testid="apply-error-banner"
					>
						<AlertCircle size={16} aria-hidden="true" />
						<span>{errorMessage}</span>
					</div>
				)}

				<div className="modal-actions">
					{!isApplying && !isDone && (
						<button
							type="button"
							className="btn btn-primary"
							onClick={() => void startApplyLoop()}
							disabled={isApplying || remainingReady === 0}
							data-testid="btn-start-apply"
						>
							{isNetworkUncertain
								? "Kalan Satırları Tekrar Dene"
								: "Uygulamayı Başlat"}
						</button>
					)}

					{!isApplying && (
						<button
							type="button"
							className="btn btn-secondary"
							onClick={onClose}
							data-testid="btn-close-apply"
						>
							{isDone ? "Kapat" : "Vazgeç"}
						</button>
					)}
				</div>
			</div>
		</AccessibleModal>
	);
}

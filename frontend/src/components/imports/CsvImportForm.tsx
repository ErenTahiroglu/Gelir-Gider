import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertCircle, FileSpreadsheet, RefreshCw, Upload } from "lucide-react";
import { type DragEvent, useRef, useState } from "react";
import { isNetworkUncertainError } from "../../api/errors";
import { stageImportBatch } from "../../api/imports-api";
import type {
	StageImportBatchRequest,
	StageImportBatchResponse,
} from "../../api/imports-types";

const MAX_CSV_BYTES = 10 * 1024 * 1024; // 10 MiB

interface CsvImportFormProps {
	onSuccess?: (data: StageImportBatchResponse) => void;
}

export function CsvImportForm({ onSuccess }: CsvImportFormProps = {}) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const fileInputRef = useRef<HTMLInputElement>(null);
	const [selectedFile, setSelectedFile] = useState<File | null>(null);
	const [fileError, setFileError] = useState<string | null>(null);
	const [isDragOver, setIsDragOver] = useState(false);

	// Frozen attempt for network uncertainty
	const [frozenStagingBody, setFrozenStagingBody] =
		useState<StageImportBatchRequest | null>(null);
	const [isNetworkUncertain, setIsNetworkUncertain] = useState(false);
	const [errorSummary, setErrorSummary] = useState<string | null>(null);

	const stageMutation = useMutation({
		mutationFn: (body: StageImportBatchRequest) => stageImportBatch(body),
		retry: false,
		onSuccess: (data: StageImportBatchResponse) => {
			setIsNetworkUncertain(false);
			setFrozenStagingBody(null);
			setErrorSummary(null);
			void queryClient.invalidateQueries({ queryKey: ["import-batches"] });
			if (onSuccess) {
				onSuccess(data);
			} else {
				void navigate({
					to: "/imports/$batchId",
					params: { batchId: data.batch.id },
				});
			}
		},
		onError: (err: unknown) => {
			if (isNetworkUncertainError(err)) {
				setIsNetworkUncertain(true);
				setErrorSummary(
					"Dosyanın yüklenip yüklenmediği doğrulanamadı. Lütfen aynı dosyayı tekrar kontrol edin.",
				);
			} else {
				setIsNetworkUncertain(false);
				setErrorSummary(
					err instanceof Error
						? err.message
						: "Dosya yüklenirken bir hata oluştu.",
				);
			}
		},
	});

	const handleFile = (file: File) => {
		setFileError(null);
		setErrorSummary(null);
		setIsNetworkUncertain(false);
		setFrozenStagingBody(null);

		// Accept only CSV
		if (
			!file.name.toLowerCase().endsWith(".csv") &&
			file.type !== "text/csv" &&
			file.type !== "application/vnd.ms-excel"
		) {
			setFileError("Lütfen geçerli bir .csv dosyası seçin.");
			setSelectedFile(null);
			return;
		}

		// 10MB limit check
		if (file.size > MAX_CSV_BYTES) {
			setFileError("Dosya 10 MB sınırını aşıyor.");
			setSelectedFile(null);
			return;
		}

		setSelectedFile(file);
	};

	const handleDrop = (e: DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		setIsDragOver(false);
		const file = e.dataTransfer.files[0];
		if (file) {
			handleFile(file);
		}
	};

	const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		setIsDragOver(true);
	};

	const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		setIsDragOver(false);
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!selectedFile) return;

		setFileError(null);
		setErrorSummary(null);

		try {
			const text = await selectedFile.text();
			const body: StageImportBatchRequest = {
				sourceKind: "GENERIC_CSV_V1",
				sourceContent: text,
				sourceFileName: selectedFile.name,
				observedAt: new Date().toISOString(),
			};
			setFrozenStagingBody(body);
			stageMutation.mutate(body);
		} catch (err) {
			setFileError(
				err instanceof Error ? err.message : "Dosya içeriği okunamadı.",
			);
		}
	};

	const handleRetryUncertain = () => {
		if (frozenStagingBody) {
			stageMutation.mutate(frozenStagingBody);
		}
	};

	return (
		<div className="csv-import-card card" data-testid="csv-import-card">
			<h2 className="card-title">Yeni CSV Ekstre Yükle</h2>
			<p className="card-subtitle">
				Kredi kartı ve gelir hareketlerini içeren standart CSV dosyanızı
				yükleyin.
			</p>

			<form onSubmit={handleSubmit} className="csv-import-form">
				{/* biome-ignore lint/a11y/useSemanticElements: file dropzone with drag and drop events */}
				<div
					className={`file-dropzone ${isDragOver ? "drag-over" : ""} ${
						selectedFile ? "has-file" : ""
					}`}
					onDrop={handleDrop}
					onDragOver={handleDragOver}
					onDragLeave={handleDragLeave}
					onClick={() => fileInputRef.current?.click()}
					role="button"
					tabIndex={0}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							fileInputRef.current?.click();
						}
					}}
					aria-label="CSV dosyasını buraya sürükleyin veya dosya seçmek için tıklayın"
					data-testid="csv-dropzone"
				>
					<input
						ref={fileInputRef}
						type="file"
						accept=".csv,text/csv"
						className="visually-hidden"
						aria-label="CSV Ekstre Dosyası Seç"
						data-testid="csv-file-input"
						onChange={(e) => {
							const file = e.target.files?.[0];
							if (file) {
								handleFile(file);
							}
						}}
					/>

					{selectedFile ? (
						<div className="selected-file-info">
							<FileSpreadsheet
								size={32}
								className="file-icon"
								aria-hidden="true"
							/>
							<div className="file-details">
								<span className="file-name" data-testid="selected-file-name">
									{selectedFile.name}
								</span>
								<span className="file-size">
									{(selectedFile.size / 1024).toFixed(1)} KB
								</span>
							</div>
							<span className="change-file-prompt">
								Değiştirmek için tıklayın
							</span>
						</div>
					) : (
						<div className="dropzone-placeholder">
							<Upload size={32} className="upload-icon" aria-hidden="true" />
							<span className="dropzone-text">
								CSV dosyanızı buraya sürükleyin veya{" "}
								<strong>dosya seçin</strong>
							</span>
							<span className="dropzone-hint">
								En fazla 10 MB (.csv formatında)
							</span>
						</div>
					)}
				</div>

				{fileError && (
					<div
						className="form-error-banner"
						role="alert"
						data-testid="file-error-banner"
					>
						<AlertCircle size={16} aria-hidden="true" />
						<span>{fileError}</span>
					</div>
				)}

				{errorSummary && (
					<div
						className="form-error-banner"
						role="alert"
						data-testid="staging-error-banner"
					>
						<AlertCircle size={16} aria-hidden="true" />
						<span>{errorSummary}</span>
					</div>
				)}

				{isNetworkUncertain && frozenStagingBody && (
					<div className="network-uncertain-action-bar">
						<button
							type="button"
							className="btn btn-warning"
							onClick={handleRetryUncertain}
							disabled={stageMutation.isPending}
							data-testid="btn-retry-staging"
						>
							<RefreshCw
								size={16}
								className={stageMutation.isPending ? "spin" : ""}
								aria-hidden="true"
							/>
							<span>Aynı Dosyayı Tekrar Kontrol Et</span>
						</button>
					</div>
				)}

				<div className="form-actions">
					<button
						type="submit"
						className="btn btn-primary"
						disabled={
							!selectedFile || stageMutation.isPending || isNetworkUncertain
						}
						data-testid="btn-upload-csv"
					>
						{stageMutation.isPending ? (
							<>
								<RefreshCw size={16} className="spin" aria-hidden="true" />
								<span>İşleniyor...</span>
							</>
						) : (
							<span>CSV Yükle ve Önizle</span>
						)}
					</button>
				</div>
			</form>
		</div>
	);
}

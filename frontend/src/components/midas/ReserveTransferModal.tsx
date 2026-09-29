import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, RefreshCw, Send } from "lucide-react";
import { useRef, useState } from "react";
import { ApiError, isNetworkUncertainError } from "../../api/errors";
import { createMidasTransfer } from "../../api/f7-api";
import type {
	CreateMidasTransferPayload,
	MidasBucketProductDto,
} from "../../api/f7-types";
import {
	formatCentsToTry,
	formatMoneyToTry,
	normalizeTurkishMoneyInput,
	parseMoneyToCents,
} from "../../lib/money";
import { AccessibleModal } from "../common/AccessibleModal";
import { MoneyInput } from "../common/MoneyInput";

interface ReserveTransferModalProps {
	isOpen: boolean;
	onClose: () => void;
	midasAccountId: string;
	reserveBucket: MidasBucketProductDto;
	unallocatedBalance: string;
	mode: "allocate" | "release";
}

export function ReserveTransferModal({
	isOpen,
	onClose,
	midasAccountId,
	reserveBucket,
	unallocatedBalance,
	mode,
}: ReserveTransferModalProps) {
	const queryClient = useQueryClient();
	const [amount, setAmount] = useState("");
	const [memo, setMemo] = useState("");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [isNetworkUncertain, setIsNetworkUncertain] = useState(false);

	// Frozen attempt ref for stable idempotent retry (Section 60, 61)
	const frozenAttemptRef = useRef<{
		key: string;
		payload: CreateMidasTransferPayload;
	} | null>(null);

	const isAllocate = mode === "allocate";
	const title = isAllocate
		? "Kart Rezervini Artır"
		: "Rezervden Serbeste Aktar";

	const maxAllowedCents = isAllocate
		? parseMoneyToCents(unallocatedBalance)
		: parseMoneyToCents(reserveBucket.balance);

	const transferMutation = useMutation({
		mutationFn: async (attempt: {
			key: string;
			payload: CreateMidasTransferPayload;
		}) => {
			return createMidasTransfer(attempt.payload, attempt.key);
		},
		onSuccess: () => {
			frozenAttemptRef.current = null;
			setIsNetworkUncertain(false);
			setErrorMessage(null);
			// Section 24 & 64: Invalidate statements, cards, and midas queries
			void queryClient.invalidateQueries({ queryKey: ["midas-liquidity"] });
			void queryClient.invalidateQueries({ queryKey: ["midas-transfers"] });
			void queryClient.invalidateQueries({ queryKey: ["active-credit-cards"] });
			void queryClient.invalidateQueries({ queryKey: ["card-statements"] });
			onClose();
		},
		onError: (err: unknown) => {
			if (isNetworkUncertainError(err)) {
				setIsNetworkUncertain(true);
				setErrorMessage(
					"Aktarımın kaydedilip kaydedilmediği doğrulanamadı. Aynı işlemi güvenli şekilde tekrar deneyebilirsiniz.",
				);
				return;
			}
			setIsNetworkUncertain(false);
			frozenAttemptRef.current = null;
			if (err instanceof ApiError) {
				setErrorMessage(err.userMessage);
			} else {
				setErrorMessage(
					err instanceof Error ? err.message : "Aktarım gerçekleştirilemedi.",
				);
			}
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (isNetworkUncertain) return;

		const norm = normalizeTurkishMoneyInput(amount);
		if (!norm.valid || !norm.canonical || norm.cents === undefined) {
			setErrorMessage(norm.error ?? "Geçersiz tutar girdiniz.");
			return;
		}

		if (norm.cents <= 0n) {
			setErrorMessage("Tutar sıfırdan büyük olmalıdır.");
			return;
		}

		if (norm.cents > maxAllowedCents) {
			const limitFormatted = formatCentsToTry(maxAllowedCents);
			setErrorMessage(
				isAllocate
					? `Aktarılabilecek azami serbest bakiye: ${limitFormatted}`
					: `Çekilebilecek azami rezerv bakiyesi: ${limitFormatted}`,
			);
			return;
		}

		setErrorMessage(null);

		// Freeze attempt once before first submission
		const key = crypto.randomUUID();
		const occurredAt = new Date().toISOString();
		const payload: CreateMidasTransferPayload = {
			midasAccountId,
			amount: norm.canonical,
			fromBucketId: isAllocate ? null : reserveBucket.bucketId,
			toBucketId: isAllocate ? reserveBucket.bucketId : null,
			memo: memo.trim() || null,
			occurredAt,
		};

		const attempt = { key, payload };
		frozenAttemptRef.current = attempt;
		transferMutation.mutate(attempt);
	};

	const handleRetry = () => {
		if (!frozenAttemptRef.current) return;
		transferMutation.mutate(frozenAttemptRef.current);
	};

	const handleModalClose = () => {
		if (transferMutation.isPending) return;
		frozenAttemptRef.current = null;
		setIsNetworkUncertain(false);
		setErrorMessage(null);
		setAmount("");
		setMemo("");
		onClose();
	};

	return (
		<AccessibleModal
			isOpen={isOpen}
			onClose={handleModalClose}
			title={title}
			className="reserve-transfer-modal"
		>
			<form
				onSubmit={handleSubmit}
				className="reserve-transfer-form"
				data-testid="reserve-transfer-form"
			>
				<div className="transfer-summary-banner">
					<div className="summary-item">
						<span className="summary-label">Mevcut Rezerv:</span>
						<span
							className="summary-value"
							data-testid="reserve-current-balance"
						>
							{formatMoneyToTry(reserveBucket.balance)}
						</span>
					</div>
					<div className="summary-item">
						<span className="summary-label">Serbest Midas Bakiye:</span>
						<span
							className="summary-value"
							data-testid="reserve-unallocated-balance"
						>
							{formatMoneyToTry(unallocatedBalance)}
						</span>
					</div>
				</div>

				{errorMessage && (
					<div
						className={`alert ${isNetworkUncertain ? "alert-warning" : "alert-danger"}`}
						role="alert"
						data-testid="reserve-transfer-alert"
					>
						<AlertCircle size={18} aria-hidden="true" />
						<div className="alert-content">
							<span>{errorMessage}</span>
							{isNetworkUncertain && (
								<div className="alert-actions mt-2">
									<button
										type="button"
										className="btn btn-sm btn-primary"
										onClick={handleRetry}
										disabled={transferMutation.isPending}
										data-testid="retry-uncertain-btn"
									>
										<RefreshCw
											size={14}
											className={transferMutation.isPending ? "spin" : ""}
											aria-hidden="true"
										/>
										<span>Aynı İşlemi Tekrar Dene</span>
									</button>
								</div>
							)}
						</div>
					</div>
				)}

				<div className="form-group">
					<label htmlFor="reserve-transfer-amount" className="form-label">
						{isAllocate ? "Eklenecek Tutar" : "Çekilecek Tutar"}
					</label>
					<MoneyInput
						id="reserve-transfer-amount"
						value={amount}
						onChange={(canonical, raw) => {
							setAmount(canonical || raw);
							setErrorMessage(null);
						}}
						disabled={transferMutation.isPending || isNetworkUncertain}
						placeholder="0,00"
						required
					/>
					<span className="form-hint">
						Azami: {formatCentsToTry(maxAllowedCents)}
					</span>
				</div>

				<div className="form-group">
					<label htmlFor="reserve-transfer-memo" className="form-label">
						Açıklama / Not (İsteğe bağlı)
					</label>
					<input
						id="reserve-transfer-memo"
						type="text"
						className="form-input"
						value={memo}
						onChange={(e) => setMemo(e.target.value)}
						disabled={transferMutation.isPending || isNetworkUncertain}
						placeholder={
							isAllocate ? "Örn: Maaştan rezerv aktarımı" : "Örn: Serbeste iade"
						}
						maxLength={200}
						data-testid="reserve-transfer-memo-input"
					/>
				</div>

				<div className="modal-actions">
					<button
						type="button"
						className="btn btn-secondary"
						onClick={handleModalClose}
						disabled={transferMutation.isPending}
					>
						Vazgeç
					</button>
					<button
						type="submit"
						className="btn btn-primary"
						disabled={transferMutation.isPending || isNetworkUncertain}
						data-testid="reserve-transfer-submit-btn"
					>
						{transferMutation.isPending ? (
							<>
								<RefreshCw size={16} className="spin" aria-hidden="true" />
								<span>İşleniyor...</span>
							</>
						) : (
							<>
								<Send size={16} aria-hidden="true" />
								<span>{isAllocate ? "Rezervi Artır" : "Serbeste Aktar"}</span>
							</>
						)}
					</button>
				</div>
			</form>
		</AccessibleModal>
	);
}

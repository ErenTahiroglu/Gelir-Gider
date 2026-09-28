/**
 * Accessible Confirmation Dialog for Voiding Manual Expenses
 *
 * Adheres strictly to Section 25, 47, 48:
 *   - "Bu işlem harcamayı silmez. Muhasebe etkisi ters kayıtla iptal edilir ve geçmişte görünmeye devam eder."
 *   - Optional reason input: "İptal nedeni"
 *   - Stable idempotency key per logical mutation attempt
 *   - Reuses same idempotency key on retry
 */

import { useState } from "react";
import { AccessibleModal } from "../common/AccessibleModal";

export interface ManualExpenseVoidDialogProps {
	isOpen: boolean;
	onClose: () => void;
	onConfirmVoid: (reason?: string) => Promise<void>;
	isPending: boolean;
	errorMessage?: string | null;
	onRetry?: () => void;
}

export function ManualExpenseVoidDialog({
	isOpen,
	onClose,
	onConfirmVoid,
	isPending,
	errorMessage,
	onRetry,
}: ManualExpenseVoidDialogProps) {
	const [reason, setReason] = useState("");

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		await onConfirmVoid(reason.trim() || undefined);
	};

	return (
		<AccessibleModal
			isOpen={isOpen}
			onClose={onClose}
			title="Harcamayı İptal Et"
			variant="center-dialog"
			description="Bu işlem harcamayı silmez. Muhasebe etkisi ters kayıtla iptal edilir."
		>
			<form onSubmit={handleSubmit} className="void-dialog-form">
				<p className="void-dialog-explanation">
					Bu işlem harcamayı silmez.
					<br />
					Muhasebe etkisi ters kayıtla iptal edilir ve geçmişte görünmeye devam
					eder.
				</p>

				<div className="form-group">
					<label htmlFor="void-reason" className="form-label">
						İptal nedeni (İsteğe bağlı)
					</label>
					<input
						type="text"
						id="void-reason"
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						placeholder="Örn: Yanlış tutar girildi"
						disabled={isPending}
						className="form-input"
						data-testid="void-reason-input"
					/>
				</div>

				{errorMessage && (
					<div
						className="form-error-banner"
						role="alert"
						data-testid="void-error-banner"
					>
						<span>{errorMessage}</span>
						{onRetry && (
							<button
								type="button"
								onClick={onRetry}
								className="btn btn-secondary btn-sm"
								style={{ marginLeft: "8px" }}
								data-testid="void-retry-btn"
							>
								Tekrar Dene
							</button>
						)}
					</div>
				)}

				<div className="modal-actions">
					<button
						type="button"
						onClick={onClose}
						disabled={isPending}
						className="btn btn-secondary"
						data-testid="void-cancel-btn"
					>
						Vazgeç
					</button>
					<button
						type="submit"
						disabled={isPending}
						className="btn btn-danger"
						data-testid="void-confirm-btn"
					>
						{isPending ? "İptal Ediliyor..." : "İptal Etmeyi Onayla"}
					</button>
				</div>
			</form>
		</AccessibleModal>
	);
}

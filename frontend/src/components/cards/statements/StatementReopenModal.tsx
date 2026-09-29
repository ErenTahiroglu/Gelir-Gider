/**
 * Credit Card Statement Payment Reopen Modal
 *
 * Implements Section 30:
 *   - Reversal lifecycle: POST /credit-cards/:cardId/statements/:statementId/reopen
 *   - Natural copy: "Bu işlem önceki ödeme kaydının muhasebe etkisini tersine çevirir ve ekstreyi yeniden açık duruma getirir."
 */

import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { mapCreditCardError } from "../../../api/credit-card-errors";
import { reopenCreditCardStatement } from "../../../api/credit-cards-api";
import type { CreditCardStatementItem } from "../../../api/credit-cards-types";
import {
	formatIstanbulDateTimeLocal,
	parseIstanbulDateTimeLocalToIso,
} from "../../../lib/istanbul-date";
import { AccessibleModal } from "../../common/AccessibleModal";

export interface StatementReopenModalProps {
	isOpen: boolean;
	cardId: string;
	statement: CreditCardStatementItem;
	onClose: () => void;
	onSuccess?: () => void;
}

export function StatementReopenModal({
	isOpen,
	cardId,
	statement,
	onClose,
	onSuccess,
}: StatementReopenModalProps) {
	const queryClient = useQueryClient();
	const [reasonNote, setReasonNote] = useState<string>("");
	const [occurredAtLocal, setOccurredAtLocal] = useState<string>(() =>
		formatIstanbulDateTimeLocal(new Date()),
	);

	const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

	const handleReopen = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsSubmitting(true);
		setErrorMessage(null);

		let occurredAtIso: string;
		try {
			occurredAtIso = parseIstanbulDateTimeLocalToIso(occurredAtLocal);
		} catch {
			setErrorMessage("Tarih ve saat biçimi geçersiz.");
			setIsSubmitting(false);
			return;
		}

		try {
			await reopenCreditCardStatement(
				cardId,
				statement.statementId,
				{
					expectedRevisionNo: statement.revisionNo,
					reasonNote: reasonNote.trim() || undefined,
					occurredAt: occurredAtIso,
				},
				idempotencyKeyRef.current,
			);

			// Authoritative invalidation per Section 61
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["active-credit-cards"] }),
				queryClient.invalidateQueries({ queryKey: ["credit-cards"] }),
				queryClient.invalidateQueries({ queryKey: ["credit-card", cardId] }),
				queryClient.invalidateQueries({
					queryKey: ["card-statements", cardId],
				}),
				queryClient.invalidateQueries({
					queryKey: ["statement", cardId, statement.statementId],
				}),
				queryClient.invalidateQueries({
					queryKey: ["statement-readiness", cardId, statement.statementId],
				}),
				queryClient.invalidateQueries({ queryKey: ["transactions"] }),
				queryClient.invalidateQueries({ queryKey: ["spending-summary"] }),
				queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] }),
				queryClient.invalidateQueries({ queryKey: ["midas-liquidity"] }),
				queryClient.invalidateQueries({ queryKey: ["budget-checkpoints"] }),
			]);

			onClose();
			if (onSuccess) onSuccess();
		} catch (err) {
			setErrorMessage(mapCreditCardError(err));
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<AccessibleModal
			isOpen={isOpen}
			onClose={onClose}
			title="Ödemeyi Geri Aç"
			description="Ödenmiş ekstrenin ödeme kaydını tersine çevirme"
		>
			<form onSubmit={handleReopen} className="reopen-modal-form" noValidate>
				<p
					style={{
						marginBottom: "1rem",
						lineHeight: 1.5,
						color: "var(--color-text-main, #1e293b)",
					}}
				>
					Bu işlem önceki ödeme kaydının muhasebe etkisini tersine çevirir ve
					ekstreyi yeniden açık duruma getirir.
				</p>

				{errorMessage && (
					<div
						className="error-alert"
						role="alert"
						data-testid="statement-reopen-error"
					>
						{errorMessage}
					</div>
				)}

				<div className="form-group">
					<label htmlFor="reopen-reason-note" className="form-label">
						Geri Açma Nedeni (Opsiyonel)
					</label>
					<input
						id="reopen-reason-note"
						type="text"
						className="form-input"
						value={reasonNote}
						onChange={(e) => setReasonNote(e.target.value)}
						placeholder="Hatalı ödeme kaydı, hesap mutabakatı vb."
						maxLength={500}
						data-testid="reopen-reason-input"
					/>
				</div>

				<div className="form-group">
					<label htmlFor="reopen-occurred-at" className="form-label">
						İşlem Tarihi / Saati *
					</label>
					<input
						id="reopen-occurred-at"
						type="datetime-local"
						className="form-input"
						value={occurredAtLocal}
						onChange={(e) => setOccurredAtLocal(e.target.value)}
						required
						data-testid="reopen-occurred-at-input"
					/>
				</div>

				<div
					className="modal-actions"
					style={{
						display: "flex",
						gap: "0.75rem",
						justifyContent: "flex-end",
						marginTop: "1.5rem",
					}}
				>
					<button
						type="button"
						className="btn btn-secondary"
						onClick={onClose}
						disabled={isSubmitting}
					>
						Vazgeç
					</button>
					<button
						type="submit"
						className="btn btn-warning"
						disabled={isSubmitting}
						data-testid="confirm-reopen-button"
						style={{
							background: "#f59e0b",
							color: "#fff",
							border: "none",
							padding: "0.5rem 1rem",
							borderRadius: "6px",
							fontWeight: 500,
						}}
					>
						{isSubmitting ? "İşleniyor..." : "Ödemeyi Geri Aç"}
					</button>
				</div>
			</form>
		</AccessibleModal>
	);
}

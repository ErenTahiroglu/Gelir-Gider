/**
 * Credit Card Statement Void Modal
 *
 * Implements Section 20:
 *   - Void: POST /credit-cards/:cardId/statements/:statementId/void
 *   - OCC + Idempotency-Key
 */

import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { mapCreditCardError } from "../../../api/credit-card-errors";
import { voidCreditCardStatement } from "../../../api/credit-cards-api";
import type { CreditCardStatementItem } from "../../../api/credit-cards-types";
import {
	formatIstanbulDateTimeLocal,
	parseIstanbulDateTimeLocalToIso,
} from "../../../lib/istanbul-date";
import { AccessibleModal } from "../../common/AccessibleModal";

export interface StatementVoidModalProps {
	isOpen: boolean;
	cardId: string;
	statement: CreditCardStatementItem;
	onClose: () => void;
	onSuccess?: () => void;
}

export function StatementVoidModal({
	isOpen,
	cardId,
	statement,
	onClose,
	onSuccess,
}: StatementVoidModalProps) {
	const queryClient = useQueryClient();
	const [reasonNote, setReasonNote] = useState<string>("");
	const [occurredAtLocal, setOccurredAtLocal] = useState<string>(() =>
		formatIstanbulDateTimeLocal(new Date()),
	);

	const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

	const handleVoid = async (e: React.FormEvent) => {
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
			await voidCreditCardStatement(
				cardId,
				statement.statementId,
				{
					expectedRevisionNo: statement.revisionNo,
					reasonNote: reasonNote.trim() || undefined,
					occurredAt: occurredAtIso,
				},
				idempotencyKeyRef.current,
			);

			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: ["card-statements", cardId],
				}),
				queryClient.invalidateQueries({
					queryKey: ["statement", cardId, statement.statementId],
				}),
				queryClient.invalidateQueries({ queryKey: ["credit-card", cardId] }),
				queryClient.invalidateQueries({ queryKey: ["credit-cards"] }),
				queryClient.invalidateQueries({ queryKey: ["midas-liquidity"] }),
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
			title="Ekstreyi İptal Et"
			description="Açık durumdaki ekstrenin iptali"
		>
			<form onSubmit={handleVoid} className="void-modal-form" noValidate>
				<p
					style={{
						marginBottom: "1rem",
						lineHeight: 1.5,
						color: "var(--color-text-main, #1e293b)",
					}}
				>
					<strong>
						{statement.cycleYear}-
						{String(statement.cycleMonth).padStart(2, "0")}
					</strong>{" "}
					dönemine ait ekstre iptal edilecektir. Bu işlem geri alınamaz.
				</p>

				{errorMessage && (
					<div
						className="error-alert"
						role="alert"
						data-testid="statement-void-error"
					>
						{errorMessage}
					</div>
				)}

				<div className="form-group">
					<label htmlFor="void-reason-note" className="form-label">
						İptal Nedeni (Opsiyonel)
					</label>
					<input
						id="void-reason-note"
						type="text"
						className="form-input"
						value={reasonNote}
						onChange={(e) => setReasonNote(e.target.value)}
						placeholder="Hatalı dönem veya tutar kaydı vb."
						maxLength={500}
						data-testid="void-reason-input"
					/>
				</div>

				<div className="form-group">
					<label htmlFor="void-occurred-at" className="form-label">
						İşlem Tarihi / Saati *
					</label>
					<input
						id="void-occurred-at"
						type="datetime-local"
						className="form-input"
						value={occurredAtLocal}
						onChange={(e) => setOccurredAtLocal(e.target.value)}
						required
						data-testid="void-occurred-at-input"
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
						className="btn btn-danger"
						disabled={isSubmitting}
						data-testid="confirm-statement-void-button"
					>
						{isSubmitting ? "İptal Ediliyor..." : "Ekstreyi İptal Et"}
					</button>
				</div>
			</form>
		</AccessibleModal>
	);
}

/**
 * Credit Card Archive Confirmation Modal
 *
 * Implements Section 13:
 *   - POST /credit-cards/:cardId/archive
 *   - On CREDIT_CARD_CANNOT_ARCHIVE_WITH_LIABILITY, show:
 *     "Bu kartın açık yükümlülüğü bulunduğu için arşivlenemiyor."
 *   - OCC: expectedRevisionNo
 */

import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { mapCreditCardError } from "../../api/credit-card-errors";
import { archiveCreditCard } from "../../api/credit-cards-api";
import type { CreditCardItem } from "../../api/credit-cards-types";
import { parseIstanbulDateTimeLocalToIso } from "../../lib/istanbul-date";
import { AccessibleModal } from "../common/AccessibleModal";

export interface CardArchiveModalProps {
	isOpen: boolean;
	card: CreditCardItem;
	onClose: () => void;
	onSuccess?: () => void;
}

export function CardArchiveModal({
	isOpen,
	card,
	onClose,
	onSuccess,
}: CardArchiveModalProps) {
	const queryClient = useQueryClient();
	const [changeReason, setChangeReason] = useState<string>("");
	const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

	const handleArchive = async () => {
		setIsSubmitting(true);
		setErrorMessage(null);

		try {
			const occurredAtIso = parseIstanbulDateTimeLocalToIso(
				new Date().toISOString().slice(0, 16),
			);

			await archiveCreditCard(
				card.cardId,
				{
					expectedRevisionNo: card.revisionNo,
					changeReason: changeReason.trim() || undefined,
					occurredAt: occurredAtIso,
				},
				idempotencyKeyRef.current,
			);

			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["credit-cards"] }),
				queryClient.invalidateQueries({ queryKey: ["active-credit-cards"] }),
				queryClient.invalidateQueries({
					queryKey: ["credit-card", card.cardId],
				}),
				queryClient.invalidateQueries({ queryKey: ["dashboard-cards"] }),
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
			title="Kartı Arşivle"
			description={`${card.displayName} kartını arşivlemek istediğinize emin misiniz?`}
		>
			<div className="archive-modal-content">
				<p className="modal-description">
					<strong>{card.displayName}</strong> ({card.issuer}
					{card.lastFour ? ` •••• ${card.lastFour}` : ""}) kartı
					arşivlenecektir. Kartın açık borcu / yükümlülüğü varsa arşivleme
					işlemi gerçekleştirilemez.
				</p>

				{errorMessage && (
					<div
						className="error-alert"
						role="alert"
						data-testid="archive-card-error"
					>
						{errorMessage}
					</div>
				)}

				<div className="form-group">
					<label htmlFor="archive-reason" className="form-label">
						Arşivleme Nedeni (Opsiyonel)
					</label>
					<input
						id="archive-reason"
						type="text"
						className="form-input"
						value={changeReason}
						onChange={(e) => setChangeReason(e.target.value)}
						placeholder="Kart iptali, kullanım dışı kalma vb."
						maxLength={500}
						data-testid="archive-reason-input"
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
						type="button"
						className="btn btn-danger"
						onClick={handleArchive}
						disabled={isSubmitting}
						data-testid="confirm-archive-card-button"
					>
						{isSubmitting ? "Arşivleniyor..." : "Kartı Arşivle"}
					</button>
				</div>
			</div>
		</AccessibleModal>
	);
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, AlertTriangle } from "lucide-react";
import { useState } from "react";
import { ApiError } from "../../api/errors";
import { archivePerson } from "../../api/people-api";
import type { PersonProductDto } from "../../api/people-types";
import { parseMoneyToCents } from "../../lib/money";
import { AccessibleModal } from "../common/AccessibleModal";

interface PersonArchiveModalProps {
	isOpen: boolean;
	onClose: () => void;
	person: PersonProductDto;
	onSuccess?: () => void;
}

export function PersonArchiveModal({
	isOpen,
	onClose,
	person,
	onSuccess,
}: PersonArchiveModalProps) {
	const queryClient = useQueryClient();
	const [error, setError] = useState<string | null>(null);

	const hasReceivableBalance = parseMoneyToCents(person.receivableBalance) > 0n;
	const hasPayableBalance = parseMoneyToCents(person.payableBalance) > 0n;
	const hasOutstandingBalance = hasReceivableBalance || hasPayableBalance;

	const archiveMutation = useMutation({
		mutationFn: async () => {
			const idempotencyKey = crypto.randomUUID();
			const now = new Date();
			const occurredAt = now.toISOString();

			return archivePerson(
				person.personId,
				{
					expectedRevisionNo: person.revisionNo,
					occurredAt,
				},
				idempotencyKey,
			);
		},
		retry: false,
		onSuccess: () => {
			// Query invalidations
			void queryClient.invalidateQueries({ queryKey: ["people"] });
			void queryClient.invalidateQueries({ queryKey: ["active-people"] });
			void queryClient.invalidateQueries({
				queryKey: ["person", person.personId],
			});
			void queryClient.invalidateQueries({
				queryKey: ["person-balance-summary", person.personId],
			});

			onClose();
			onSuccess?.();
		},
		onError: (err) => {
			if (err instanceof ApiError) {
				setError(err.userMessage);
			} else {
				setError("Kişi arşivlenirken bir hata oluştu.");
			}
		},
	});

	const handleArchive = () => {
		setError(null);
		archiveMutation.mutate();
	};

	return (
		<AccessibleModal
			isOpen={isOpen}
			onClose={onClose}
			title="Kişiyi Arşivle"
			className="person-archive-modal"
		>
			<div
				className="person-archive-content"
				data-testid="person-archive-modal"
			>
				{error && (
					<div
						className="person-error-alert alert alert-danger"
						role="alert"
						data-testid="archive-error-alert"
					>
						<AlertCircle size={18} aria-hidden="true" />
						<span>{error}</span>
					</div>
				)}

				<div className="person-archive-prompt">
					<p>
						<strong>{person.displayName}</strong> adlı kişiyi arşivlemek
						istediğinize emin misiniz?
					</p>
					<p className="text-secondary">
						Arşivlenen kişiler yeni borç/alacak işlemlerinde ve aktif listelerde
						görünmez.
					</p>
				</div>

				{hasOutstandingBalance && (
					<div
						className="person-warning-box alert alert-warning"
						data-testid="archive-balance-warning"
					>
						<AlertTriangle size={18} aria-hidden="true" />
						<span>
							Bu kişide açık borç veya alacak bakiyesi bulunmaktadır. Arşivleme
							işlemi başarısız olabilir.
						</span>
					</div>
				)}

				<div className="modal-actions">
					<button
						type="button"
						className="btn btn-secondary"
						onClick={onClose}
						disabled={archiveMutation.isPending}
					>
						Vazgeç
					</button>
					<button
						type="button"
						className="btn btn-danger"
						onClick={handleArchive}
						disabled={archiveMutation.isPending}
						data-testid="confirm-archive-btn"
					>
						{archiveMutation.isPending ? "Arşivleniyor..." : "Arşivle"}
					</button>
				</div>
			</div>
		</AccessibleModal>
	);
}

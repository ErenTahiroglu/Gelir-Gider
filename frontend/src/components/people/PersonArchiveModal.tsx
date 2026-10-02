import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, AlertTriangle } from "lucide-react";
import { useRef, useState } from "react";
import { ApiError, isNetworkUncertainError } from "../../api/errors";
import "../../api/domain-errors";
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

interface FrozenArchiveAttempt {
	key: string;
	payload: {
		expectedRevisionNo: number;
		occurredAt: string;
	};
}

export function PersonArchiveModal({
	isOpen,
	onClose,
	person,
	onSuccess,
}: PersonArchiveModalProps) {
	const queryClient = useQueryClient();
	const [error, setError] = useState<string | null>(null);
	const [isNetworkUncertain, setIsNetworkUncertain] = useState(false);
	const frozenAttemptRef = useRef<FrozenArchiveAttempt | null>(null);

	const hasReceivableBalance = parseMoneyToCents(person.receivableBalance) > 0n;
	const hasPayableBalance = parseMoneyToCents(person.payableBalance) > 0n;
	const hasOutstandingBalance = hasReceivableBalance || hasPayableBalance;

	const handleClose = () => {
		frozenAttemptRef.current = null;
		setIsNetworkUncertain(false);
		setError(null);
		onClose();
	};

	const archiveMutation = useMutation({
		mutationFn: async (attempt: FrozenArchiveAttempt) => {
			return archivePerson(person.personId, attempt.payload, attempt.key);
		},
		retry: false,
		onSuccess: () => {
			frozenAttemptRef.current = null;
			setIsNetworkUncertain(false);
			setError(null);

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
			if (isNetworkUncertainError(err)) {
				setIsNetworkUncertain(true);
				setError(null);
				return;
			}
			setIsNetworkUncertain(false);
			if (err instanceof ApiError) {
				setError(err.userMessage);
			} else {
				setError("Kişi arşivlenirken bir hata oluştu.");
			}
		},
	});

	const handleArchive = () => {
		setError(null);
		setIsNetworkUncertain(false);
		const attempt: FrozenArchiveAttempt = {
			key: crypto.randomUUID(),
			payload: {
				expectedRevisionNo: person.revisionNo,
				occurredAt: new Date().toISOString(),
			},
		};
		frozenAttemptRef.current = attempt;
		archiveMutation.mutate(attempt);
	};

	const handleRetryUncertain = () => {
		if (!frozenAttemptRef.current) return;
		setError(null);
		archiveMutation.mutate(frozenAttemptRef.current);
	};

	return (
		<AccessibleModal
			isOpen={isOpen}
			onClose={handleClose}
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

				{isNetworkUncertain && (
					<div
						className="person-uncertain-alert alert alert-warning"
						role="alert"
						data-testid="archive-uncertain-alert"
					>
						<AlertCircle size={18} aria-hidden="true" />
						<div>
							<p>İşlemin kaydedilip kaydedilmediği doğrulanamadı.</p>
							<button
								type="button"
								className="btn btn-secondary btn-sm mt-2"
								onClick={handleRetryUncertain}
								disabled={archiveMutation.isPending}
								data-testid="retry-uncertain-btn"
							>
								Aynı İşlemi Tekrar Dene
							</button>
						</div>
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
						onClick={handleClose}
						disabled={archiveMutation.isPending}
					>
						Vazgeç
					</button>
					<button
						type="button"
						className="btn btn-danger"
						onClick={handleArchive}
						disabled={archiveMutation.isPending || isNetworkUncertain}
						data-testid="confirm-archive-btn"
					>
						{archiveMutation.isPending ? "Arşivleniyor..." : "Arşivle"}
					</button>
				</div>
			</div>
		</AccessibleModal>
	);
}

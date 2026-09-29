import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	AlertCircle,
	CheckCircle2,
	RefreshCw,
	RotateCcw,
	XCircle,
} from "lucide-react";
import { useRef, useState } from "react";
import { ApiError, isNetworkUncertainError } from "../../api/errors";
import {
	cancelLongTermTask,
	markSentLongTermTask,
	reopenLongTermTask,
} from "../../api/f7-api";
import type {
	CancelLongTermTaskPayload,
	LongTermTaskProductDto,
	MarkSentLongTermTaskPayload,
	ReopenLongTermTaskPayload,
} from "../../api/f7-types";
import { formatMoneyToTry } from "../../lib/money";
import { AccessibleModal } from "../common/AccessibleModal";

export type LongTermActionType = "mark-sent" | "reopen" | "cancel";

interface LongTermLifecycleModalProps {
	isOpen: boolean;
	onClose: () => void;
	task: LongTermTaskProductDto;
	actionType: LongTermActionType;
	onSuccess?: () => void;
}

export function LongTermLifecycleModal({
	isOpen,
	onClose,
	task,
	actionType,
	onSuccess,
}: LongTermLifecycleModalProps) {
	const queryClient = useQueryClient();
	const [reasonNote, setReasonNote] = useState("");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [isNetworkUncertain, setIsNetworkUncertain] = useState(false);

	const frozenAttemptRef = useRef<{
		key: string;
		payload:
			| MarkSentLongTermTaskPayload
			| ReopenLongTermTaskPayload
			| CancelLongTermTaskPayload;
	} | null>(null);

	const title =
		actionType === "mark-sent"
			? "Gönderildi Olarak İşaretle"
			: actionType === "reopen"
				? "Gönderimi Geri Aç"
				: "Görevi İptal Et";

	const invalidateRelatedQueries = () => {
		void queryClient.invalidateQueries({ queryKey: ["long-term-tasks"] });
		void queryClient.invalidateQueries({
			queryKey: ["long-term-task", task.taskId],
		});
		void queryClient.invalidateQueries({ queryKey: ["midas-liquidity"] });
		void queryClient.invalidateQueries({ queryKey: ["midas-transfers"] });
		void queryClient.invalidateQueries({ queryKey: ["transactions"] });
		void queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] });
	};

	const markSentMutation = useMutation({
		mutationFn: async (attempt: {
			key: string;
			payload: MarkSentLongTermTaskPayload;
		}) => {
			return markSentLongTermTask(task.taskId, attempt.payload, attempt.key);
		},
		onSuccess: () => {
			frozenAttemptRef.current = null;
			setIsNetworkUncertain(false);
			setErrorMessage(null);
			invalidateRelatedQueries();
			onSuccess?.();
			onClose();
		},
		onError: (err: unknown) => {
			if (isNetworkUncertainError(err)) {
				setIsNetworkUncertain(true);
				setErrorMessage(
					"İşlemin kaydedilip kaydedilmediği doğrulanamadı. Aynı işlemi güvenli şekilde tekrar deneyebilirsiniz.",
				);
				return;
			}
			setIsNetworkUncertain(false);
			frozenAttemptRef.current = null;
			if (err instanceof ApiError) {
				setErrorMessage(err.userMessage);
			} else {
				setErrorMessage(
					err instanceof Error ? err.message : "İşlem gerçekleştirilemedi.",
				);
			}
		},
	});

	const reopenMutation = useMutation({
		mutationFn: async (attempt: {
			key: string;
			payload: ReopenLongTermTaskPayload;
		}) => {
			return reopenLongTermTask(task.taskId, attempt.payload, attempt.key);
		},
		onSuccess: () => {
			frozenAttemptRef.current = null;
			setIsNetworkUncertain(false);
			setErrorMessage(null);
			invalidateRelatedQueries();
			onSuccess?.();
			onClose();
		},
		onError: (err: unknown) => {
			if (isNetworkUncertainError(err)) {
				setIsNetworkUncertain(true);
				setErrorMessage(
					"Geri açma işleminin kaydedilip kaydedilmediği doğrulanamadı. Aynı işlemi güvenli şekilde tekrar deneyebilirsiniz.",
				);
				return;
			}
			setIsNetworkUncertain(false);
			frozenAttemptRef.current = null;
			if (err instanceof ApiError) {
				setErrorMessage(err.userMessage);
			} else {
				setErrorMessage(
					err instanceof Error ? err.message : "İşlem gerçekleştirilemedi.",
				);
			}
		},
	});

	const cancelMutation = useMutation({
		mutationFn: async (attempt: {
			key: string;
			payload: CancelLongTermTaskPayload;
		}) => {
			return cancelLongTermTask(task.taskId, attempt.payload, attempt.key);
		},
		onSuccess: () => {
			frozenAttemptRef.current = null;
			setIsNetworkUncertain(false);
			setErrorMessage(null);
			invalidateRelatedQueries();
			onSuccess?.();
			onClose();
		},
		onError: (err: unknown) => {
			if (isNetworkUncertainError(err)) {
				setIsNetworkUncertain(true);
				setErrorMessage(
					"İptal işleminin kaydedilip kaydedilmediği doğrulanamadı. Aynı işlemi güvenli şekilde tekrar deneyebilirsiniz.",
				);
				return;
			}
			setIsNetworkUncertain(false);
			frozenAttemptRef.current = null;
			if (err instanceof ApiError) {
				setErrorMessage(err.userMessage);
			} else {
				setErrorMessage(
					err instanceof Error ? err.message : "İşlem gerçekleştirilemedi.",
				);
			}
		},
	});

	const isPending =
		markSentMutation.isPending ||
		reopenMutation.isPending ||
		cancelMutation.isPending;

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (isNetworkUncertain || isPending) return;

		setErrorMessage(null);

		const key = crypto.randomUUID();
		const occurredAt = new Date().toISOString();

		if (actionType === "mark-sent") {
			const payload: MarkSentLongTermTaskPayload = {
				expectedRevisionNo: task.revisionNo,
				occurredAt,
			};
			const attempt = { key, payload };
			frozenAttemptRef.current = attempt;
			markSentMutation.mutate(attempt);
		} else if (actionType === "reopen") {
			const payload: ReopenLongTermTaskPayload = {
				expectedRevisionNo: task.revisionNo,
				reasonNote: reasonNote.trim() || null,
				occurredAt,
			};
			const attempt = { key, payload };
			frozenAttemptRef.current = attempt;
			reopenMutation.mutate(attempt);
		} else {
			const payload: CancelLongTermTaskPayload = {
				expectedRevisionNo: task.revisionNo,
				reasonNote: reasonNote.trim() || null,
				occurredAt,
			};
			const attempt = { key, payload };
			frozenAttemptRef.current = attempt;
			cancelMutation.mutate(attempt);
		}
	};

	const handleRetry = () => {
		if (!frozenAttemptRef.current) return;
		if (actionType === "mark-sent") {
			markSentMutation.mutate(
				frozenAttemptRef.current as {
					key: string;
					payload: MarkSentLongTermTaskPayload;
				},
			);
		} else if (actionType === "reopen") {
			reopenMutation.mutate(
				frozenAttemptRef.current as {
					key: string;
					payload: ReopenLongTermTaskPayload;
				},
			);
		} else {
			cancelMutation.mutate(
				frozenAttemptRef.current as {
					key: string;
					payload: CancelLongTermTaskPayload;
				},
			);
		}
	};

	const handleModalClose = () => {
		if (isPending) return;
		frozenAttemptRef.current = null;
		setIsNetworkUncertain(false);
		setErrorMessage(null);
		setReasonNote("");
		onClose();
	};

	return (
		<AccessibleModal
			isOpen={isOpen}
			onClose={handleModalClose}
			title={title}
			className="long-term-lifecycle-modal"
		>
			<form
				onSubmit={handleSubmit}
				className="lifecycle-form"
				data-testid="long-term-lifecycle-form"
			>
				<div className="task-summary-banner mb-4">
					<div className="summary-item">
						<span className="summary-label">Tutar:</span>
						<span
							className="summary-value font-mono font-bold"
							data-testid="task-summary-amount"
						>
							{formatMoneyToTry(task.amount)}
						</span>
					</div>
					{task.destinationLabel && (
						<div className="summary-item">
							<span className="summary-label">Hedef:</span>
							<span
								className="summary-value font-medium"
								data-testid="task-summary-destination"
							>
								{task.destinationLabel}
							</span>
						</div>
					)}
				</div>

				{/* Section 54, 56, 57 Explanatory copy */}
				<div className="alert alert-info mb-4" role="note">
					{actionType === "mark-sent" && (
						<span>
							Bu işlem paranın Midas'tan uzun vadeli yatırım hedefine fiziksel
							olarak gönderildiğini kaydeder.
						</span>
					)}
					{actionType === "reopen" && (
						<span>
							Önceki gönderim kaydının muhasebe etkisi tersine çevrilir ve görev
							yeniden beklemeye alınır.
						</span>
					)}
					{actionType === "cancel" && (
						<span>
							Görev iptal edilir ve ayrılan sanal bakiye Midas Serbest Bakiye'ye
							iade edilir.
						</span>
					)}
				</div>

				{errorMessage && (
					<div
						className={`alert ${isNetworkUncertain ? "alert-warning" : "alert-danger"} mb-4`}
						role="alert"
						data-testid="lifecycle-alert"
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
										disabled={isPending}
										data-testid="retry-uncertain-btn"
									>
										<RefreshCw
											size={14}
											className={isPending ? "spin" : ""}
											aria-hidden="true"
										/>
										<span>Aynı İşlemi Tekrar Dene</span>
									</button>
								</div>
							)}
						</div>
					</div>
				)}

				{(actionType === "reopen" || actionType === "cancel") && (
					<div className="form-group mb-4">
						<label htmlFor="lifecycle-reason-note" className="form-label">
							Gerekçe / Not (İsteğe bağlı)
						</label>
						<input
							id="lifecycle-reason-note"
							type="text"
							className="form-input"
							value={reasonNote}
							onChange={(e) => setReasonNote(e.target.value)}
							disabled={isPending || isNetworkUncertain}
							placeholder="İşlem gerekçesini yazabilirsiniz..."
							maxLength={200}
							data-testid="lifecycle-reason-note-input"
						/>
					</div>
				)}

				<div className="modal-actions flex justify-end gap-3 mt-6">
					<button
						type="button"
						className="btn btn-secondary"
						onClick={handleModalClose}
						disabled={isPending}
					>
						Vazgeç
					</button>

					<button
						type="submit"
						className={`btn ${
							actionType === "cancel" ? "btn-danger" : "btn-primary"
						}`}
						disabled={isPending || isNetworkUncertain}
						data-testid="lifecycle-submit-btn"
					>
						{isPending ? (
							<>
								<RefreshCw size={16} className="spin" aria-hidden="true" />
								<span>İşleniyor...</span>
							</>
						) : actionType === "mark-sent" ? (
							<>
								<CheckCircle2 size={16} aria-hidden="true" />
								<span>Gönderildi Olarak İşaretle</span>
							</>
						) : actionType === "reopen" ? (
							<>
								<RotateCcw size={16} aria-hidden="true" />
								<span>Gönderimi Geri Aç</span>
							</>
						) : (
							<>
								<XCircle size={16} aria-hidden="true" />
								<span>Görevi İptal Et</span>
							</>
						)}
					</button>
				</div>
			</form>
		</AccessibleModal>
	);
}

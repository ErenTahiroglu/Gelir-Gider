import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	AlertCircle,
	ArrowDownLeft,
	ArrowUpRight,
	RefreshCw,
} from "lucide-react";
import { useRef, useState } from "react";
import { ApiError, isNetworkUncertainError } from "../../api/errors";
import { fundShortTermGoal, releaseShortTermGoal } from "../../api/f7-api";
import type {
	FundShortTermGoalPayload,
	ReleaseShortTermGoalPayload,
	ShortTermGoalProductDto,
} from "../../api/f7-types";
import {
	formatCentsToTry,
	formatMoneyToTry,
	normalizeTurkishMoneyInput,
	parseMoneyToCents,
} from "../../lib/money";
import { AccessibleModal } from "../common/AccessibleModal";
import { MoneyInput } from "../common/MoneyInput";

interface GoalFundingModalProps {
	isOpen: boolean;
	onClose: () => void;
	goal: ShortTermGoalProductDto;
	unallocatedBalance?: string | undefined;
	mode: "fund" | "release";
}

export function GoalFundingModal({
	isOpen,
	onClose,
	goal,
	unallocatedBalance,
	mode,
}: GoalFundingModalProps) {
	const queryClient = useQueryClient();
	const [amount, setAmount] = useState("");
	const [memo, setMemo] = useState("");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [isNetworkUncertain, setIsNetworkUncertain] = useState(false);

	const frozenFundAttemptRef = useRef<{
		key: string;
		payload: FundShortTermGoalPayload;
	} | null>(null);

	const frozenReleaseAttemptRef = useRef<{
		key: string;
		payload: ReleaseShortTermGoalPayload;
	} | null>(null);

	const isFund = mode === "fund";
	const title = isFund ? "Hedefi Fonla" : "Hedef Fonunu Serbest Bırak";

	// Section 37 & 38: Client Funding Limits
	// Source: liquidity.unallocatedBalance
	// If maxBudget !== null: maxAllowed = min(unallocatedBalance, maxBudget - accumulatedAmount)
	// If maxBudget === null: maxAllowed = unallocatedBalance
	// IMPORTANT: fundingTarget is NOT the hard cap!
	const unallocatedCents =
		unallocatedBalance !== undefined
			? parseMoneyToCents(unallocatedBalance)
			: 0n;
	const accumulatedCents = parseMoneyToCents(goal.accumulatedAmount);

	let maxAllowedCents = 0n;
	if (isFund) {
		if (unallocatedBalance === undefined) {
			maxAllowedCents = 0n;
		} else if (goal.maxBudget !== null) {
			const maxBudgetCents = parseMoneyToCents(goal.maxBudget);
			const budgetRemainingCents =
				maxBudgetCents > accumulatedCents
					? maxBudgetCents - accumulatedCents
					: 0n;
			maxAllowedCents =
				unallocatedCents < budgetRemainingCents
					? unallocatedCents
					: budgetRemainingCents;
		} else {
			maxAllowedCents = unallocatedCents;
		}
	} else {
		// Release max is accumulatedAmount
		maxAllowedCents = accumulatedCents;
	}

	const fundMutation = useMutation({
		mutationFn: async (attempt: {
			key: string;
			payload: FundShortTermGoalPayload;
		}) => {
			return fundShortTermGoal(goal.goalId, attempt.payload, attempt.key);
		},
		onSuccess: () => {
			frozenFundAttemptRef.current = null;
			setIsNetworkUncertain(false);
			setErrorMessage(null);
			void queryClient.invalidateQueries({ queryKey: ["short-term-goals"] });
			void queryClient.invalidateQueries({
				queryKey: ["short-term-goal", goal.goalId],
			});
			void queryClient.invalidateQueries({ queryKey: ["midas-liquidity"] });
			void queryClient.invalidateQueries({ queryKey: ["midas-transfers"] });
			onClose();
		},
		onError: (err: unknown) => {
			if (isNetworkUncertainError(err)) {
				setIsNetworkUncertain(true);
				setErrorMessage(
					"Fonlama işleminin kaydedilip kaydedilmediği doğrulanamadı. Aynı işlemi güvenli şekilde tekrar deneyebilirsiniz.",
				);
				return;
			}
			setIsNetworkUncertain(false);
			frozenFundAttemptRef.current = null;
			if (err instanceof ApiError) {
				setErrorMessage(err.userMessage);
			} else {
				setErrorMessage(
					err instanceof Error
						? err.message
						: "Fonlama işlemi gerçekleştirilemedi.",
				);
			}
		},
	});

	const releaseMutation = useMutation({
		mutationFn: async (attempt: {
			key: string;
			payload: ReleaseShortTermGoalPayload;
		}) => {
			return releaseShortTermGoal(goal.goalId, attempt.payload, attempt.key);
		},
		onSuccess: () => {
			frozenReleaseAttemptRef.current = null;
			setIsNetworkUncertain(false);
			setErrorMessage(null);
			void queryClient.invalidateQueries({ queryKey: ["short-term-goals"] });
			void queryClient.invalidateQueries({
				queryKey: ["short-term-goal", goal.goalId],
			});
			void queryClient.invalidateQueries({ queryKey: ["midas-liquidity"] });
			void queryClient.invalidateQueries({ queryKey: ["midas-transfers"] });
			onClose();
		},
		onError: (err: unknown) => {
			if (isNetworkUncertainError(err)) {
				setIsNetworkUncertain(true);
				setErrorMessage(
					"Serbest bırakma işleminin kaydedilip kaydedilmediği doğrulanamadı. Aynı işlemi güvenli şekilde tekrar deneyebilirsiniz.",
				);
				return;
			}
			setIsNetworkUncertain(false);
			frozenReleaseAttemptRef.current = null;
			if (err instanceof ApiError) {
				setErrorMessage(err.userMessage);
			} else {
				setErrorMessage(
					err instanceof Error
						? err.message
						: "Serbest bırakma işlemi gerçekleştirilemedi.",
				);
			}
		},
	});

	const isPending = fundMutation.isPending || releaseMutation.isPending;

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (isNetworkUncertain) return;

		if (isFund && unallocatedBalance === undefined) {
			setErrorMessage(
				"Midas serbest bakiye durumu doğrulanamadığı için fonlama işlemi yapılamaz.",
			);
			return;
		}

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
				isFund
					? `Aktarılabilecek azami tutar: ${limitFormatted}`
					: `Serbest bırakılabilecek azami tutar: ${limitFormatted}`,
			);
			return;
		}

		setErrorMessage(null);

		const key = crypto.randomUUID();
		const occurredAt = new Date().toISOString();

		if (isFund) {
			const payload: FundShortTermGoalPayload = {
				amount: norm.canonical,
				fromBucketId: null, // Always from unallocated Serbest Bakiye
				memo: memo.trim() || null,
				occurredAt,
			};
			const attempt = { key, payload };
			frozenFundAttemptRef.current = attempt;
			fundMutation.mutate(attempt);
		} else {
			const payload: ReleaseShortTermGoalPayload = {
				amount: norm.canonical,
				toBucketId: null, // Always back to unallocated Serbest Bakiye
				memo: memo.trim() || null,
				occurredAt,
			};
			const attempt = { key, payload };
			frozenReleaseAttemptRef.current = attempt;
			releaseMutation.mutate(attempt);
		}
	};

	const handleRetry = () => {
		if (isFund && frozenFundAttemptRef.current) {
			fundMutation.mutate(frozenFundAttemptRef.current);
		} else if (!isFund && frozenReleaseAttemptRef.current) {
			releaseMutation.mutate(frozenReleaseAttemptRef.current);
		}
	};

	const handleModalClose = () => {
		if (isPending) return;
		frozenFundAttemptRef.current = null;
		frozenReleaseAttemptRef.current = null;
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
			className="goal-funding-modal"
		>
			<form
				onSubmit={handleSubmit}
				className="goal-funding-form"
				data-testid="goal-funding-form"
			>
				<div className="transfer-summary-banner">
					<div className="summary-item">
						<span className="summary-label">Hedef:</span>
						<span className="summary-value font-medium">{goal.name}</span>
					</div>
					<div className="summary-item">
						<span className="summary-label">Birikmiş Bakiye:</span>
						<span className="summary-value font-mono">
							{formatMoneyToTry(goal.accumulatedAmount)} /{" "}
							{formatMoneyToTry(goal.fundingTarget)}
						</span>
					</div>
					{unallocatedBalance !== undefined && (
						<div className="summary-item">
							<span className="summary-label">Serbest Midas Bakiye:</span>
							<span className="summary-value font-mono">
								{formatMoneyToTry(unallocatedBalance)}
							</span>
						</div>
					)}
				</div>

				{errorMessage && (
					<div
						className={`alert ${isNetworkUncertain ? "alert-warning" : "alert-danger"}`}
						role="alert"
						data-testid="goal-funding-alert"
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

				<div className="form-group">
					<label htmlFor="goal-funding-amount" className="form-label">
						{isFund ? "Fonlanacak Tutar" : "Çekilecek Tutar"}
					</label>
					<MoneyInput
						id="goal-funding-amount"
						value={amount}
						onChange={(canonical, raw) => {
							setAmount(canonical || raw);
							setErrorMessage(null);
						}}
						disabled={isPending || isNetworkUncertain}
						placeholder="0,00"
						required
					/>
					<span className="form-hint">
						Azami: {formatCentsToTry(maxAllowedCents)}
						{isFund && goal.maxBudget && (
							<span> (Azami Bütçe: {formatMoneyToTry(goal.maxBudget)})</span>
						)}
					</span>
				</div>

				<div className="form-group">
					<label htmlFor="goal-funding-memo" className="form-label">
						Açıklama / Not (İsteğe bağlı)
					</label>
					<input
						id="goal-funding-memo"
						type="text"
						className="form-input"
						value={memo}
						onChange={(e) => setMemo(e.target.value)}
						disabled={isPending || isNetworkUncertain}
						placeholder={isFund ? "Örn: Maaştan aktarım" : "Örn: Serbeste iade"}
						maxLength={200}
						data-testid="goal-funding-memo-input"
					/>
				</div>

				<div className="modal-actions">
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
						className="btn btn-primary"
						disabled={isPending || isNetworkUncertain}
						data-testid="goal-funding-submit-btn"
					>
						{isPending ? (
							<>
								<RefreshCw size={16} className="spin" aria-hidden="true" />
								<span>İşleniyor...</span>
							</>
						) : (
							<>
								{isFund ? (
									<ArrowUpRight size={16} aria-hidden="true" />
								) : (
									<ArrowDownLeft size={16} aria-hidden="true" />
								)}
								<span>{isFund ? "Hedefe Aktar" : "Serbeste Aktar"}</span>
							</>
						)}
					</button>
				</div>
			</form>
		</AccessibleModal>
	);
}

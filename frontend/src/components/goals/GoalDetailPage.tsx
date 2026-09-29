import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	AlertCircle,
	ArrowDownLeft,
	ArrowLeft,
	ArrowUpRight,
	Calendar,
	CheckCircle2,
	Edit,
	ExternalLink,
	RefreshCw,
	XCircle,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { ApiError, isNetworkUncertainError } from "../../api/errors";
import {
	cancelShortTermGoal,
	completeShortTermGoal,
	fetchMidasLiquidity,
	fetchShortTermGoal,
} from "../../api/f7-api";
import type {
	CancelShortTermGoalPayload,
	CompleteShortTermGoalPayload,
} from "../../api/f7-types";
import { formatDueDateRelativeTurkish } from "../../lib/istanbul-date";
import { classifyMidasLiquidityState } from "../../lib/midas-state";
import { formatMoneyToTry, parseMoneyToCents } from "../../lib/money";
import { GoalFundingModal } from "./GoalFundingModal";

interface GoalDetailPageProps {
	goalId: string;
}

export function GoalDetailPage({ goalId }: GoalDetailPageProps) {
	const queryClient = useQueryClient();

	const [isFundingModalOpen, setIsFundingModalOpen] = useState(false);
	const [fundingMode, setFundingMode] = useState<"fund" | "release">("fund");

	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [isNetworkUncertain, setIsNetworkUncertain] = useState(false);

	const frozenCompleteAttemptRef = useRef<{
		key: string;
		payload: CompleteShortTermGoalPayload;
	} | null>(null);

	const frozenCancelAttemptRef = useRef<{
		key: string;
		payload: CancelShortTermGoalPayload;
	} | null>(null);

	const {
		data: goalData,
		isLoading: goalLoading,
		error: goalError,
		refetch: refetchGoal,
		isFetching: goalFetching,
	} = useQuery({
		queryKey: ["short-term-goal", goalId],
		queryFn: () => fetchShortTermGoal(goalId),
		staleTime: 30_000,
	});

	const goal = goalData?.goal;

	// Check Midas liquidity authority (R1)
	const {
		data: liquidityData,
		isLoading: liquidityLoading,
		error: liquidityError,
		refetch: refetchLiquidity,
	} = useQuery({
		queryKey: ["midas-liquidity"],
		queryFn: () => fetchMidasLiquidity(),
		staleTime: 30_000,
		retry: false,
	});

	const midasClassification = classifyMidasLiquidityState(
		liquidityLoading,
		liquidityData,
		liquidityError,
	);

	const isMidasConfigured = midasClassification.status === "CONFIGURED";
	const unallocatedBalance =
		midasClassification.status === "CONFIGURED"
			? midasClassification.liquidity.unallocatedBalance
			: undefined;

	const hasNonZeroBalance = useMemo(() => {
		if (!goal) return false;
		try {
			return parseMoneyToCents(goal.accumulatedAmount) > 0n;
		} catch {
			return false;
		}
	}, [goal]);

	const completeMutation = useMutation({
		mutationFn: async (attempt: {
			key: string;
			payload: CompleteShortTermGoalPayload;
		}) => {
			return completeShortTermGoal(goalId, attempt.payload, attempt.key);
		},
		onSuccess: () => {
			frozenCompleteAttemptRef.current = null;
			setIsNetworkUncertain(false);
			setErrorMessage(null);
			void queryClient.invalidateQueries({ queryKey: ["short-term-goals"] });
			void queryClient.invalidateQueries({
				queryKey: ["short-term-goal", goalId],
			});
			void queryClient.invalidateQueries({ queryKey: ["midas-liquidity"] });
		},
		onError: (err: unknown) => {
			if (isNetworkUncertainError(err)) {
				setIsNetworkUncertain(true);
				setErrorMessage(
					"Tamamlama işleminin kaydedilip kaydedilmediği doğrulanamadı. Aynı işlemi güvenli şekilde tekrar deneyebilirsiniz.",
				);
				return;
			}
			setIsNetworkUncertain(false);
			frozenCompleteAttemptRef.current = null;
			if (err instanceof ApiError) {
				setErrorMessage(err.userMessage);
			} else {
				setErrorMessage(
					err instanceof Error ? err.message : "Hedef tamamlanamadı.",
				);
			}
		},
	});

	const cancelMutation = useMutation({
		mutationFn: async (attempt: {
			key: string;
			payload: CancelShortTermGoalPayload;
		}) => {
			return cancelShortTermGoal(goalId, attempt.payload, attempt.key);
		},
		onSuccess: () => {
			frozenCancelAttemptRef.current = null;
			setIsNetworkUncertain(false);
			setErrorMessage(null);
			void queryClient.invalidateQueries({ queryKey: ["short-term-goals"] });
			void queryClient.invalidateQueries({
				queryKey: ["short-term-goal", goalId],
			});
			void queryClient.invalidateQueries({ queryKey: ["midas-liquidity"] });
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
			frozenCancelAttemptRef.current = null;
			if (err instanceof ApiError) {
				setErrorMessage(err.userMessage);
			} else {
				setErrorMessage(
					err instanceof Error ? err.message : "Hedef iptal edilemedi.",
				);
			}
		},
	});

	const isActionPending =
		completeMutation.isPending || cancelMutation.isPending;

	// Section 40: Complete goal
	const handleComplete = () => {
		if (!goal || isActionPending || isNetworkUncertain) return;
		if (hasNonZeroBalance) {
			setErrorMessage(
				"Bu hedefte ayrılmış para bulunduğu için tamamlanamaz. Önce bakiyeyi serbest bırakın.",
			);
			return;
		}

		const key = crypto.randomUUID();
		const occurredAt = new Date().toISOString();
		const payload: CompleteShortTermGoalPayload = {
			expectedRevisionNo: goal.latestRevisionNo,
			occurredAt,
		};
		const attempt = { key, payload };
		frozenCompleteAttemptRef.current = attempt;
		completeMutation.mutate(attempt);
	};

	// Section 41: Cancel goal
	const handleCancel = () => {
		if (!goal || isActionPending || isNetworkUncertain) return;
		if (hasNonZeroBalance) {
			setErrorMessage(
				"Bu hedefte ayrılmış para bulunduğu için iptal edilemez. Önce bakiyeyi Serbest Bakiye'ye aktarın.",
			);
			return;
		}

		const key = crypto.randomUUID();
		const occurredAt = new Date().toISOString();
		const payload: CancelShortTermGoalPayload = {
			expectedRevisionNo: goal.latestRevisionNo,
			occurredAt,
		};
		const attempt = { key, payload };
		frozenCancelAttemptRef.current = attempt;
		cancelMutation.mutate(attempt);
	};

	const handleRetry = () => {
		if (frozenCompleteAttemptRef.current) {
			completeMutation.mutate(frozenCompleteAttemptRef.current);
		} else if (frozenCancelAttemptRef.current) {
			cancelMutation.mutate(frozenCancelAttemptRef.current);
		}
	};

	if (goalLoading) {
		return (
			<div className="page-container" data-testid="goal-detail-loading">
				<div className="loading-state">
					<RefreshCw size={24} className="spin" aria-hidden="true" />
					<span>Hedef bilgileri yükleniyor...</span>
				</div>
			</div>
		);
	}

	if (goalError || !goal) {
		return (
			<div className="page-container" data-testid="goal-detail-error">
				<div className="alert alert-danger" role="alert">
					<AlertCircle size={20} aria-hidden="true" />
					<div className="alert-content">
						<span>
							{goalError instanceof ApiError
								? goalError.userMessage
								: "Hedef bulunamadı."}
						</span>
						<Link to="/goals" className="btn btn-sm btn-secondary mt-2">
							Hedefler Listesine Dön
						</Link>
					</div>
				</div>
			</div>
		);
	}

	const clampedPercentage = Math.min(
		100,
		Math.max(0, goal.progressPercentage || 0),
	);

	return (
		<div
			className="page-container goal-detail-page"
			data-testid="goal-detail-page"
		>
			{/* Breadcrumb / Back button */}
			<div className="mb-4">
				<Link
					to="/goals"
					className="btn btn-ghost btn-sm"
					data-testid="back-to-goals-btn"
				>
					<ArrowLeft size={16} aria-hidden="true" />
					<span>Tüm Hedefler</span>
				</Link>
			</div>

			{/* Page Header */}
			<div className="page-header flex justify-between items-start">
				<div>
					<div className="flex items-center gap-2 mb-1">
						<span
							className={`badge ${
								goal.status === "ACTIVE"
									? "badge-success"
									: goal.status === "COMPLETED"
										? "badge-primary"
										: "badge-secondary"
							}`}
							data-testid="goal-status-badge"
						>
							{goal.status === "ACTIVE"
								? "Aktif"
								: goal.status === "COMPLETED"
									? "Tamamlandı"
									: "İptal Edildi"}
						</span>
						{goal.priority !== null && (
							<span
								className="badge badge-subtle"
								data-testid="goal-priority-badge"
							>
								Öncelik #{goal.priority}
							</span>
						)}
					</div>
					<h1 className="page-title" data-testid="goal-title">
						{goal.name}
					</h1>
				</div>

				<div className="flex items-center gap-2">
					<button
						type="button"
						className="btn btn-secondary btn-sm"
						onClick={() => void refetchGoal()}
						disabled={goalFetching}
						title="Yenile"
						aria-label="Yenile"
					>
						<RefreshCw
							size={16}
							className={goalFetching ? "spin" : ""}
							aria-hidden="true"
						/>
					</button>

					{goal.status === "ACTIVE" && (
						<Link
							to="/goals/$goalId/edit"
							params={{ goalId }}
							className="btn btn-secondary btn-sm"
							data-testid="goal-edit-btn"
						>
							<Edit size={16} aria-hidden="true" />
							<span>Düzenle</span>
						</Link>
					)}
				</div>
			</div>

			{/* Uncertainty Alert */}
			{isNetworkUncertain && errorMessage && (
				<div
					className="alert alert-warning mb-4"
					role="alert"
					data-testid="goal-uncertain-alert"
				>
					<AlertCircle size={18} aria-hidden="true" />
					<div className="alert-content">
						<span>{errorMessage}</span>
						<div className="alert-actions mt-2">
							<button
								type="button"
								className="btn btn-sm btn-primary"
								onClick={handleRetry}
								disabled={isActionPending}
								data-testid="retry-uncertain-btn"
							>
								<RefreshCw
									size={14}
									className={isActionPending ? "spin" : ""}
									aria-hidden="true"
								/>
								<span>Aynı İşlemi Tekrar Dene</span>
							</button>
						</div>
					</div>
				</div>
			)}

			{/* General Error Alert */}
			{!isNetworkUncertain && errorMessage && (
				<div
					className="alert alert-danger mb-4"
					role="alert"
					data-testid="goal-error-alert"
				>
					<AlertCircle size={18} aria-hidden="true" />
					<div className="alert-content">
						<span>{errorMessage}</span>
					</div>
				</div>
			)}

			{/* Progress & Target Section */}
			<div className="card goal-progress-card mb-6">
				<div className="card-body">
					<div className="goal-amounts-overview flex justify-between items-baseline mb-3">
						<div>
							<span className="text-xs text-muted block">Biriken Tutar</span>
							<span
								className="text-2xl font-bold font-mono text-primary"
								data-testid="goal-accumulated-amount"
							>
								{formatMoneyToTry(goal.accumulatedAmount)}
							</span>
						</div>
						<div className="text-right">
							<span className="text-xs text-muted block">Hedef Tutar</span>
							<span
								className="text-xl font-semibold font-mono text-muted"
								data-testid="goal-funding-target"
							>
								{formatMoneyToTry(goal.fundingTarget)}
							</span>
						</div>
					</div>

					{/* Authoritative Progress Bar (Section 29) */}
					<div
						className="progress-bar-container"
						role="progressbar"
						aria-valuenow={goal.progressPercentage}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-label={`${goal.name} ilerleme oranı`}
					>
						<div
							className={`progress-bar-fill ${
								goal.progressPercentage >= 100 ? "bg-success" : "bg-primary"
							}`}
							style={{ width: `${clampedPercentage}%` }}
						/>
					</div>

					<div className="progress-bar-footer flex justify-between items-center mt-2 text-xs text-muted">
						<span data-testid="goal-progress-percentage">
							%{goal.progressPercentage} tamamlandı
						</span>
						<span data-testid="goal-remaining-amount">
							Kalan: {formatMoneyToTry(goal.remainingToTarget)}
						</span>
					</div>

					{/* Goal Funding Actions */}
					{goal.status === "ACTIVE" && (
						<div className="goal-funding-section mt-6">
							<div className="goal-funding-action-btns flex gap-3">
								<button
									type="button"
									className="btn btn-primary flex-1"
									onClick={() => {
										setFundingMode("fund");
										setIsFundingModalOpen(true);
									}}
									disabled={!isMidasConfigured}
									title={
										midasClassification.status === "LOADING"
											? "Midas likidite durumu yükleniyor..."
											: midasClassification.status === "NOT_CONFIGURED"
												? "Midas hesabı bağlı olmadığı için fonlama yapılamaz"
												: midasClassification.status === "ERROR"
													? "Midas serbest bakiye durumu doğrulanamadığı için fonlama yapılamaz"
													: undefined
									}
									data-testid="open-fund-modal-btn"
								>
									{midasClassification.status === "LOADING" ? (
										<RefreshCw size={16} className="spin" aria-hidden="true" />
									) : (
										<ArrowUpRight size={16} aria-hidden="true" />
									)}
									<span>Para Aktar (Fonla)</span>
								</button>

								<button
									type="button"
									className="btn btn-secondary flex-1"
									onClick={() => {
										setFundingMode("release");
										setIsFundingModalOpen(true);
									}}
									disabled={!hasNonZeroBalance}
									title={
										!hasNonZeroBalance
											? "Hedefte çekilecek bakiye bulunmuyor"
											: undefined
									}
									data-testid="open-release-modal-btn"
								>
									<ArrowDownLeft size={16} aria-hidden="true" />
									<span>Para Çek (Serbeste)</span>
								</button>
							</div>

							{/* Midas Authority Error Alert (R1) */}
							{midasClassification.status === "ERROR" && (
								<div
									className="alert alert-danger mt-3"
									role="alert"
									data-testid="midas-authority-error-alert"
								>
									<AlertCircle size={16} aria-hidden="true" />
									<div className="alert-content flex-1">
										<span>
											Midas serbest bakiye durumu doğrulanamadığı için fonlama
											işlemi yapılamaz.
										</span>
										<button
											type="button"
											className="btn btn-sm btn-secondary mt-1 inline-flex"
											onClick={() => void refetchLiquidity()}
											data-testid="retry-liquidity-btn"
										>
											<span>Yeniden Dene</span>
										</button>
									</div>
								</div>
							)}
						</div>
					)}
				</div>
			</div>

			{/* Goal Metadata Card */}
			<div className="card goal-details-card mb-6">
				<div className="card-header">
					<h2 className="card-title text-base">Hedef Detayları</h2>
				</div>
				<div className="card-body">
					<dl className="details-list">
						{goal.targetDate && (
							<div className="details-row">
								<dt className="details-term">Hedef Tarihi</dt>
								<dd className="details-def flex items-center gap-2">
									<Calendar
										size={16}
										className="text-muted"
										aria-hidden="true"
									/>
									<span data-testid="goal-target-date">
										{goal.targetDate} (
										{formatDueDateRelativeTurkish(goal.targetDate)})
									</span>
								</dd>
							</div>
						)}

						{goal.maxBudget && (
							<div className="details-row">
								<dt className="details-term">Azami Bütçe</dt>
								<dd
									className="details-def font-mono"
									data-testid="goal-max-budget"
								>
									{formatMoneyToTry(goal.maxBudget)}
								</dd>
							</div>
						)}

						{goal.targetPrice && (
							<div className="details-row">
								<dt className="details-term">Hedef Ürün Fiyatı</dt>
								<dd
									className="details-def font-mono"
									data-testid="goal-target-price"
								>
									{formatMoneyToTry(goal.targetPrice)}
								</dd>
							</div>
						)}

						{goal.productUrl && (
							<div className="details-row">
								<dt className="details-term">Ürün Bağlantısı</dt>
								<dd className="details-def">
									<a
										href={goal.productUrl}
										target="_blank"
										rel="noopener noreferrer"
										className="link flex items-center gap-1"
										data-testid="goal-product-url"
									>
										<span>Bağlantıyı Aç</span>
										<ExternalLink size={14} aria-hidden="true" />
									</a>
								</dd>
							</div>
						)}

						{goal.note && (
							<div className="details-row">
								<dt className="details-term">Not</dt>
								<dd className="details-def" data-testid="goal-note">
									{goal.note}
								</dd>
							</div>
						)}
					</dl>
				</div>
			</div>

			{/* Lifecycle Status & Actions (Section 40 & 41) */}
			{goal.status === "ACTIVE" && (
				<div className="card goal-lifecycle-card">
					<div className="card-header">
						<h2 className="card-title text-base">Hedef Yönetimi</h2>
					</div>
					<div className="card-body">
						<div className="lifecycle-actions flex flex-col sm:flex-row gap-3">
							<button
								type="button"
								className="btn btn-secondary"
								onClick={handleComplete}
								disabled={isActionPending || hasNonZeroBalance}
								title={
									hasNonZeroBalance
										? "Tamamlamadan önce biriken bakiyeyi serbest bırakın"
										: undefined
								}
								data-testid="goal-complete-btn"
							>
								<CheckCircle2 size={16} aria-hidden="true" />
								<span>Hedefi Tamamla</span>
							</button>

							<button
								type="button"
								className="btn btn-danger-outline"
								onClick={handleCancel}
								disabled={isActionPending || hasNonZeroBalance}
								title={
									hasNonZeroBalance
										? "İptal etmeden önce biriken bakiyeyi serbest bırakın"
										: undefined
								}
								data-testid="goal-cancel-btn"
							>
								<XCircle size={16} aria-hidden="true" />
								<span>Hedefi İptal Et</span>
							</button>
						</div>

						{hasNonZeroBalance && (
							<p className="text-xs text-muted mt-2">
								* Hedefi tamamlamak veya iptal etmek için önce içindeki{" "}
								<strong>{formatMoneyToTry(goal.accumulatedAmount)}</strong>{" "}
								bakiyeyi Serbest Midas Bakiyesi'ne aktarın.
							</p>
						)}
					</div>
				</div>
			)}

			{/* Funding Modal */}
			{isFundingModalOpen && (
				<GoalFundingModal
					isOpen={isFundingModalOpen}
					onClose={() => setIsFundingModalOpen(false)}
					goal={goal}
					unallocatedBalance={unallocatedBalance}
					mode={fundingMode}
				/>
			)}
		</div>
	);
}

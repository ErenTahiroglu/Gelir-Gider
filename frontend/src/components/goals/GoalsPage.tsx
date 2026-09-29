import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	AlertCircle,
	ArrowDown,
	ArrowUp,
	Calendar,
	CheckCircle2,
	ChevronRight,
	Plus,
	RefreshCw,
	Sliders,
	Target,
	Wallet,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { ApiError, isNetworkUncertainError } from "../../api/errors";
import {
	fetchAllActiveShortTermGoals,
	fetchMidasLiquidity,
	fetchShortTermGoals,
	reorderShortTermGoals,
} from "../../api/f7-api";
import type {
	ReorderShortTermGoalsPayload,
	ShortTermGoalProductDto,
	ShortTermGoalStatus,
} from "../../api/f7-types";
import { formatDueDateRelativeTurkish } from "../../lib/istanbul-date";
import { classifyMidasLiquidityState } from "../../lib/midas-state";
import { formatMoneyToTry } from "../../lib/money";

export function GoalsPage() {
	const queryClient = useQueryClient();

	const [statusTab, setStatusTab] = useState<ShortTermGoalStatus>("ACTIVE");
	const [cursor, setCursor] = useState<string | undefined>(undefined);
	const [goalPages, setGoalPages] = useState<ShortTermGoalProductDto[][]>([]);

	// Reorder mode states
	const [isReordering, setIsReordering] = useState(false);
	const [orderedGoals, setOrderedGoals] = useState<ShortTermGoalProductDto[]>(
		[],
	);
	const [isFetchingAllForReorder, setIsFetchingAllForReorder] = useState(false);
	const [reorderError, setReorderError] = useState<string | null>(null);
	const [isReorderUncertain, setIsReorderUncertain] = useState(false);

	const frozenReorderAttemptRef = useRef<{
		key: string;
		payload: ReorderShortTermGoalsPayload;
	} | null>(null);

	// Check Midas liquidity state (R1)
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
	const isMidasNotConfigured = midasClassification.status === "NOT_CONFIGURED";
	const isMidasError = midasClassification.status === "ERROR";
	const midasAccountId =
		midasClassification.status === "CONFIGURED"
			? midasClassification.liquidity.midasAccountId
			: undefined;

	// Fetch short-term goals for current tab
	const {
		data: goalsData,
		isLoading: goalsLoading,
		refetch,
		isFetching,
	} = useQuery({
		queryKey: ["short-term-goals", { status: statusTab, after: cursor }],
		queryFn: () =>
			fetchShortTermGoals({
				midasAccountId: midasAccountId ?? undefined,
				status: statusTab,
				limit: 50,
				after: cursor,
			}),
		staleTime: 30_000,
	});

	const currentGoals = goalsData?.goals ?? [];
	const hasMore = Boolean(goalsData?.hasMore && goalsData?.nextCursor);

	const handleTabChange = (newTab: ShortTermGoalStatus) => {
		setStatusTab(newTab);
		setCursor(undefined);
		setGoalPages([]);
		setIsReordering(false);
		setReorderError(null);
	};

	const handleLoadMore = () => {
		if (goalsData?.nextCursor) {
			setGoalPages((prev) => [...prev, currentGoals]);
			setCursor(goalsData.nextCursor);
		}
	};

	const allVisibleGoals = useMemo(() => {
		const combined = goalPages.flat();
		return [...combined, ...currentGoals];
	}, [goalPages, currentGoals]);

	// Section 44: When user begins reordering, fetch the COMPLETE set of ACTIVE goals
	const handleStartReordering = async () => {
		if (!midasAccountId) return;
		setIsFetchingAllForReorder(true);
		setReorderError(null);
		setIsReorderUncertain(false);

		try {
			const completeActiveGoals =
				await fetchAllActiveShortTermGoals(midasAccountId);
			setOrderedGoals(completeActiveGoals);
			setIsReordering(true);
		} catch (err) {
			setReorderError(
				err instanceof ApiError
					? err.userMessage
					: "Hedef sıralaması için liste yüklenemedi.",
			);
		} finally {
			setIsFetchingAllForReorder(false);
		}
	};

	const handleCancelReordering = () => {
		setIsReordering(false);
		setOrderedGoals([]);
		setReorderError(null);
		setIsReorderUncertain(false);
		frozenReorderAttemptRef.current = null;
	};

	// Reorder up / down steppers
	const moveGoal = (index: number, direction: "up" | "down") => {
		const targetIndex = direction === "up" ? index - 1 : index + 1;
		if (targetIndex < 0 || targetIndex >= orderedGoals.length) return;

		const updated = [...orderedGoals];
		const temp = updated[index];
		const target = updated[targetIndex];
		if (!temp || !target) return;

		updated[index] = target;
		updated[targetIndex] = temp;
		setOrderedGoals(updated);
	};

	const reorderMutation = useMutation({
		mutationFn: async (attempt: {
			key: string;
			payload: ReorderShortTermGoalsPayload;
		}) => {
			return reorderShortTermGoals(attempt.payload, attempt.key);
		},
		onSuccess: () => {
			frozenReorderAttemptRef.current = null;
			setIsReorderUncertain(false);
			setIsReordering(false);
			setReorderError(null);
			void queryClient.invalidateQueries({ queryKey: ["short-term-goals"] });
		},
		onError: async (err: unknown) => {
			if (isNetworkUncertainError(err)) {
				setIsReorderUncertain(true);
				setReorderError(
					"Sıralama kaydının tamamlanıp tamamlanmadığı doğrulanamadı. Aynı işlemi güvenli şekilde tekrar deneyebilirsiniz.",
				);
				return;
			}
			setIsReorderUncertain(false);
			frozenReorderAttemptRef.current = null;

			if (
				err instanceof ApiError &&
				(err.code === "SHORT_TERM_GOAL_PRIORITY_COLLISION" ||
					err.code === "SHORT_TERM_GOAL_PRIORITY_MISMATCH" ||
					err.code === "SHORT_TERM_GOAL_PRIORITY_CONFLICT")
			) {
				// Section 46: Conflict -> refetch all active goals and require user review
				setReorderError(
					"Hedef listesi değiştiği için sıralama güncellenemedi. Güncel liste yüklendi, lütfen tekrar sıralayın.",
				);
				if (midasAccountId) {
					try {
						const refreshed =
							await fetchAllActiveShortTermGoals(midasAccountId);
						setOrderedGoals(refreshed);
					} catch {
						// Ignored
					}
				}
				return;
			}

			if (err instanceof ApiError) {
				setReorderError(err.userMessage);
			} else {
				setReorderError(
					err instanceof Error ? err.message : "Sıralama kaydedilemedi.",
				);
			}
		},
	});

	const handleSaveReorder = () => {
		if (!midasAccountId || isReorderUncertain || reorderMutation.isPending)
			return;

		const key = crypto.randomUUID();
		const occurredAt = new Date().toISOString();
		const orderedGoalIds = orderedGoals.map((g) => g.goalId);

		const payload: ReorderShortTermGoalsPayload = {
			midasAccountId,
			orderedGoalIds,
			occurredAt,
		};

		const attempt = { key, payload };
		frozenReorderAttemptRef.current = attempt;
		reorderMutation.mutate(attempt);
	};

	const handleRetryReorder = () => {
		if (frozenReorderAttemptRef.current) {
			reorderMutation.mutate(frozenReorderAttemptRef.current);
		}
	};

	return (
		<div className="page-container goals-page" data-testid="goals-page">
			{/* Header */}
			<div className="page-header flex justify-between items-center">
				<div>
					<h1 className="page-title">Kısa Vadeli Hedefler</h1>
					<p className="page-subtitle">
						Öncelikli birikim ve harcama hedeflerinizin takibi
					</p>
				</div>

				<div className="flex items-center gap-2">
					<button
						type="button"
						className="btn btn-secondary btn-sm"
						onClick={() => void refetch()}
						disabled={isFetching}
						title="Yenile"
						aria-label="Yenile"
					>
						<RefreshCw
							size={16}
							className={isFetching ? "spin" : ""}
							aria-hidden="true"
						/>
					</button>

					{isMidasConfigured ? (
						<Link
							to="/goals/new"
							className="btn btn-primary btn-sm"
							data-testid="create-goal-btn"
						>
							<Plus size={16} aria-hidden="true" />
							<span>Yeni Hedef</span>
						</Link>
					) : (
						<button
							type="button"
							className="btn btn-primary btn-sm opacity-50 cursor-not-allowed"
							disabled
							title={
								isMidasNotConfigured
									? "Hedef oluşturmak için önce Midas likidite hesabını bağlayın"
									: "Midas likidite durumu doğrulanamadı"
							}
							data-testid="create-goal-btn"
						>
							<Plus size={16} aria-hidden="true" />
							<span>Yeni Hedef</span>
						</button>
					)}
				</div>
			</div>

			{/* Midas setup warning if not configured (Section 31 & R1) */}
			{isMidasNotConfigured && (
				<div
					className="alert alert-warning mb-6"
					role="alert"
					data-testid="midas-not-configured-alert"
				>
					<Wallet size={20} aria-hidden="true" />
					<div className="alert-content flex-1">
						<span>
							Kısa vadeli hedef oluşturmak ve fonlamak için önce Midas likidite
							hesabını bağlayın.
						</span>
						<Link
							to="/midas"
							className="btn btn-sm btn-primary mt-2 inline-flex"
							data-testid="link-to-midas-setup"
						>
							<span>Midas'ı Kur</span>
						</Link>
					</div>
				</div>
			)}

			{/* Midas authority error (R1) */}
			{isMidasError && (
				<div
					className="alert alert-danger mb-6"
					role="alert"
					data-testid="midas-authority-error-alert"
				>
					<AlertCircle size={20} aria-hidden="true" />
					<div className="alert-content flex-1">
						<span>
							Midas likidite durumu doğrulanamadı. Fonlama ve yeni hedef
							işlemleri için tekrar deneyin.
						</span>
						<button
							type="button"
							className="btn btn-sm btn-secondary mt-2 inline-flex"
							onClick={() => void refetchLiquidity()}
							data-testid="retry-liquidity-btn"
						>
							<span>Yeniden Dene</span>
						</button>
					</div>
				</div>
			)}

			{/* Status Tabs */}
			<div className="tabs-container mb-4" role="tablist">
				<button
					type="button"
					role="tab"
					aria-selected={statusTab === "ACTIVE"}
					className={`tab-btn ${statusTab === "ACTIVE" ? "active" : ""}`}
					onClick={() => handleTabChange("ACTIVE")}
					data-testid="tab-active-goals"
				>
					<span>Aktif</span>
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={statusTab === "COMPLETED"}
					className={`tab-btn ${statusTab === "COMPLETED" ? "active" : ""}`}
					onClick={() => handleTabChange("COMPLETED")}
					data-testid="tab-completed-goals"
				>
					<span>Tamamlanan</span>
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={statusTab === "CANCELLED"}
					className={`tab-btn ${statusTab === "CANCELLED" ? "active" : ""}`}
					onClick={() => handleTabChange("CANCELLED")}
					data-testid="tab-cancelled-goals"
				>
					<span>İptal Edilen</span>
				</button>
			</div>

			{/* Reorder Toolbar for ACTIVE goals */}
			{statusTab === "ACTIVE" &&
				allVisibleGoals.length > 1 &&
				!isReordering && (
					<div className="flex justify-end mb-3">
						<button
							type="button"
							className="btn btn-secondary btn-sm"
							onClick={handleStartReordering}
							disabled={isFetchingAllForReorder || !isMidasConfigured}
							data-testid="start-reorder-btn"
						>
							{isFetchingAllForReorder ? (
								<>
									<RefreshCw size={14} className="spin" aria-hidden="true" />
									<span>Yükleniyor...</span>
								</>
							) : (
								<>
									<Sliders size={14} aria-hidden="true" />
									<span>Öncelikleri Düzenle</span>
								</>
							)}
						</button>
					</div>
				)}

			{/* Reorder Interface */}
			{isReordering ? (
				<div className="card reorder-card mb-6" data-testid="reorder-interface">
					<div className="card-header flex justify-between items-center">
						<h2 className="card-title text-base">
							Öncelik Sıralamasını Düzenle
						</h2>
						<span className="text-xs text-muted">
							Yukarı/Aşağı butonları ile sırayı belirleyin
						</span>
					</div>

					<div className="card-body">
						{reorderError && (
							<div
								className={`alert ${isReorderUncertain ? "alert-warning" : "alert-danger"} mb-4`}
								role="alert"
								data-testid="reorder-error-alert"
							>
								<AlertCircle size={18} aria-hidden="true" />
								<div className="alert-content">
									<span>{reorderError}</span>
									{isReorderUncertain && (
										<div className="alert-actions mt-2">
											<button
												type="button"
												className="btn btn-sm btn-primary"
												onClick={handleRetryReorder}
												disabled={reorderMutation.isPending}
												data-testid="retry-uncertain-btn"
											>
												<RefreshCw
													size={14}
													className={reorderMutation.isPending ? "spin" : ""}
													aria-hidden="true"
												/>
												<span>Aynı İşlemi Tekrar Dene</span>
											</button>
										</div>
									)}
								</div>
							</div>
						)}

						<div className="reorder-list">
							{orderedGoals.map((goal, idx) => (
								<div
									key={goal.goalId}
									className="reorder-item card-subtle flex justify-between items-center p-3 mb-2"
									data-testid={`reorder-item-${goal.goalId}`}
								>
									<div className="flex items-center gap-3">
										<span className="priority-badge font-bold text-sm">
											#{idx + 1}
										</span>
										<div>
											<span className="goal-name font-medium block">
												{goal.name}
											</span>
											<span className="text-xs text-muted font-mono">
												{formatMoneyToTry(goal.accumulatedAmount)} /{" "}
												{formatMoneyToTry(goal.fundingTarget)}
											</span>
										</div>
									</div>

									<div className="stepper-buttons flex items-center gap-1">
										<button
											type="button"
											className="btn btn-secondary btn-icon-sm"
											onClick={() => moveGoal(idx, "up")}
											disabled={
												idx === 0 ||
												reorderMutation.isPending ||
												isReorderUncertain
											}
											aria-label={`${goal.name} yukarı taşı`}
											data-testid={`move-up-${goal.goalId}`}
										>
											<ArrowUp size={16} aria-hidden="true" />
										</button>
										<button
											type="button"
											className="btn btn-secondary btn-icon-sm"
											onClick={() => moveGoal(idx, "down")}
											disabled={
												idx === orderedGoals.length - 1 ||
												reorderMutation.isPending ||
												isReorderUncertain
											}
											aria-label={`${goal.name} aşağı taşı`}
											data-testid={`move-down-${goal.goalId}`}
										>
											<ArrowDown size={16} aria-hidden="true" />
										</button>
									</div>
								</div>
							))}
						</div>

						<div className="reorder-actions flex justify-end gap-3 mt-4">
							<button
								type="button"
								className="btn btn-secondary"
								onClick={handleCancelReordering}
								disabled={reorderMutation.isPending}
							>
								Vazgeç
							</button>
							<button
								type="button"
								className="btn btn-primary"
								onClick={handleSaveReorder}
								disabled={reorderMutation.isPending || isReorderUncertain}
								data-testid="save-reorder-btn"
							>
								{reorderMutation.isPending ? (
									<>
										<RefreshCw size={16} className="spin" aria-hidden="true" />
										<span>Kaydediliyor...</span>
									</>
								) : (
									<>
										<CheckCircle2 size={16} aria-hidden="true" />
										<span>Sıralamayı Kaydet</span>
									</>
								)}
							</button>
						</div>
					</div>
				</div>
			) : (
				/* Goal Cards Grid */
				<div className="goals-content">
					{goalsLoading && allVisibleGoals.length === 0 ? (
						<div className="loading-state">
							<RefreshCw size={24} className="spin" aria-hidden="true" />
							<span>Hedefler yükleniyor...</span>
						</div>
					) : allVisibleGoals.length === 0 ? (
						<div className="card text-center p-8" data-testid="empty-goals">
							<div className="header-icon-badge mx-auto mb-3">
								<Target size={28} aria-hidden="true" />
							</div>
							<h3 className="font-semibold mb-1">Hedef Bulunamadı</h3>
							<p className="text-muted text-sm mb-4">
								{statusTab === "ACTIVE"
									? "Henüz aktif bir birikim hedefi oluşturmadınız."
									: statusTab === "COMPLETED"
										? "Tamamlanmış bir hedef bulunmuyor."
										: "İptal edilmiş bir hedef bulunmuyor."}
							</p>
							{statusTab === "ACTIVE" && (
								<Link
									to="/goals/new"
									className="btn btn-primary btn-sm"
									data-testid="create-first-goal-btn"
								>
									<Plus size={16} aria-hidden="true" />
									<span>İlk Hedefinizi Ekleyin</span>
								</Link>
							)}
						</div>
					) : (
						<div className="goals-grid" data-testid="goals-list">
							{allVisibleGoals.map((goal) => {
								const clampedPercentage = Math.min(
									100,
									Math.max(0, goal.progressPercentage || 0),
								);
								return (
									<Link
										key={goal.goalId}
										to="/goals/$goalId"
										params={{ goalId: goal.goalId }}
										className="card goal-card hover-lift block"
										aria-label={`${goal.name} hedef detayı`}
										data-testid={`goal-card-${goal.goalId}`}
									>
										<div className="card-header flex justify-between items-start pb-2">
											<div className="flex-1 mr-2">
												{goal.priority !== null && (
													<span className="badge badge-subtle mb-1">
														Öncelik #{goal.priority}
													</span>
												)}
												<h3 className="card-title text-base font-semibold">
													{goal.name}
												</h3>
											</div>
											<ChevronRight
												size={18}
												className="text-muted shrink-0 mt-1"
												aria-hidden="true"
											/>
										</div>

										<div className="card-body pt-2">
											<div className="flex justify-between items-baseline mb-2">
												<span className="font-mono text-lg font-bold text-primary">
													{formatMoneyToTry(goal.accumulatedAmount)}
												</span>
												<span className="font-mono text-sm text-muted">
													/ {formatMoneyToTry(goal.fundingTarget)}
												</span>
											</div>

											{/* Authoritative Progress Bar */}
											<div
												className="progress-bar-container"
												role="progressbar"
												aria-valuenow={goal.progressPercentage}
												aria-valuemin={0}
												aria-valuemax={100}
											>
												<div
													className={`progress-bar-fill ${
														goal.progressPercentage >= 100
															? "bg-success"
															: "bg-primary"
													}`}
													style={{ width: `${clampedPercentage}%` }}
												/>
											</div>

											<div className="flex justify-between items-center mt-2 text-xs text-muted">
												<span>%{goal.progressPercentage} tamamlandı</span>
												{goal.targetDate && (
													<span className="flex items-center gap-1">
														<Calendar size={12} aria-hidden="true" />
														<span>
															{formatDueDateRelativeTurkish(goal.targetDate)}
														</span>
													</span>
												)}
											</div>
										</div>
									</Link>
								);
							})}
						</div>
					)}

					{hasMore && (
						<div className="pagination-footer mt-6 text-center">
							<button
								type="button"
								className="btn btn-secondary btn-sm"
								onClick={handleLoadMore}
								disabled={isFetching}
								data-testid="load-more-goals-btn"
							>
								{isFetching ? (
									<>
										<RefreshCw size={14} className="spin" aria-hidden="true" />
										<span>Yükleniyor...</span>
									</>
								) : (
									<span>Daha Fazla Göster</span>
								)}
							</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

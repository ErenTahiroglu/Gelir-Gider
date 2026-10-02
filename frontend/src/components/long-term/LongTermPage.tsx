import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	AlertCircle,
	CheckCircle2,
	ChevronRight,
	Clock,
	Plus,
	RefreshCw,
	TrendingUp,
	Wallet,
} from "lucide-react";
import { useMemo, useState } from "react";
import "../../api/domain-errors";
import { fetchLongTermTasks, fetchMidasLiquidity } from "../../api/f7-api";
import type {
	LongTermTaskProductDto,
	LongTermTaskStatus,
} from "../../api/f7-types";
import { formatIstanbulDateTimeTurkish } from "../../lib/istanbul-date";
import { classifyMidasLiquidityState } from "../../lib/midas-state";
import { formatMoneyToTry } from "../../lib/money";

export function LongTermPage() {
	const [statusTab, setStatusTab] = useState<LongTermTaskStatus>("PENDING");
	const [cursor, setCursor] = useState<string | undefined>(undefined);
	const [taskPages, setTaskPages] = useState<LongTermTaskProductDto[][]>([]);

	// Check Midas configuration (R1)
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

	// Fetch tasks
	const {
		data: tasksData,
		isLoading: tasksLoading,
		refetch,
		isFetching,
	} = useQuery({
		queryKey: ["long-term-tasks", { status: statusTab, after: cursor }],
		queryFn: () =>
			fetchLongTermTasks({
				midasAccountId: midasAccountId ?? undefined,
				status: statusTab,
				limit: 50,
				after: cursor,
			}),
		staleTime: 30_000,
	});

	const currentTasks = tasksData?.tasks ?? [];
	const hasMore = Boolean(tasksData?.hasMore && tasksData?.nextCursor);

	const handleTabChange = (newTab: LongTermTaskStatus) => {
		setStatusTab(newTab);
		setCursor(undefined);
		setTaskPages([]);
	};

	const handleLoadMore = () => {
		if (tasksData?.nextCursor) {
			setTaskPages((prev) => [...prev, currentTasks]);
			setCursor(tasksData.nextCursor);
		}
	};

	const allVisibleTasks = useMemo(() => {
		const combined = taskPages.flat();
		return [...combined, ...currentTasks];
	}, [taskPages, currentTasks]);

	return (
		<div className="page-container long-term-page" data-testid="long-term-page">
			{/* Header */}
			<div className="page-header flex justify-between items-center">
				<div>
					<h1 className="page-title">Uzun Vadeli Yatırım Görevleri</h1>
					<p className="page-subtitle">
						Midas'tan harici yatırım hesaplarına varlık transfer takibi
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
							to="/long-term/new"
							className="btn btn-primary btn-sm"
							data-testid="create-task-btn"
						>
							<Plus size={16} aria-hidden="true" />
							<span>Yeni Görev</span>
						</Link>
					) : (
						<button
							type="button"
							className="btn btn-primary btn-sm opacity-50 cursor-not-allowed"
							disabled
							title={
								isMidasNotConfigured
									? "Görev oluşturmak için önce Midas likidite hesabını bağlayın"
									: "Midas likidite durumu doğrulanamadı"
							}
							data-testid="create-task-btn"
						>
							<Plus size={16} aria-hidden="true" />
							<span>Yeni Görev</span>
						</button>
					)}
				</div>
			</div>

			{/* Midas setup warning if not configured (R1) */}
			{isMidasNotConfigured && (
				<div
					className="alert alert-warning mb-6"
					role="alert"
					data-testid="midas-not-configured-alert"
				>
					<Wallet size={20} aria-hidden="true" />
					<div className="alert-content flex-1">
						<span>
							Uzun vadeli yatırım görevi oluşturmak için önce Midas likidite
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
							Midas likidite durumu doğrulanamadı. Yeni uzun vadeli görev
							oluşturmak için tekrar deneyin.
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

			{/* Section 48 Concept Banner */}
			<div className="alert alert-info mb-6" role="note">
				<TrendingUp size={18} aria-hidden="true" />
				<span>
					Uzun Vadeli Yatırımlar, Midas serbest bakiyesinden harici aracı
					kurumlara yapılacak fiili para transferlerini yönetir. Serbest bakiye
					yatırımın kendisi değildir.
				</span>
			</div>

			{/* Status Tabs */}
			<div className="tabs-container mb-4" role="tablist">
				<button
					type="button"
					role="tab"
					aria-selected={statusTab === "PENDING"}
					className={`tab-btn ${statusTab === "PENDING" ? "active" : ""}`}
					onClick={() => handleTabChange("PENDING")}
					data-testid="tab-pending-tasks"
				>
					<span>Beklemede</span>
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={statusTab === "SENT"}
					className={`tab-btn ${statusTab === "SENT" ? "active" : ""}`}
					onClick={() => handleTabChange("SENT")}
					data-testid="tab-sent-tasks"
				>
					<span>Gönderildi</span>
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={statusTab === "CANCELLED"}
					className={`tab-btn ${statusTab === "CANCELLED" ? "active" : ""}`}
					onClick={() => handleTabChange("CANCELLED")}
					data-testid="tab-cancelled-tasks"
				>
					<span>İptal Edilen</span>
				</button>
			</div>

			{/* Task List */}
			<div className="tasks-content">
				{tasksLoading && allVisibleTasks.length === 0 ? (
					<div className="loading-state">
						<RefreshCw size={24} className="spin" aria-hidden="true" />
						<span>Görevler yükleniyor...</span>
					</div>
				) : allVisibleTasks.length === 0 ? (
					<div className="card text-center p-8" data-testid="empty-tasks">
						<div className="header-icon-badge mx-auto mb-3">
							<TrendingUp size={28} aria-hidden="true" />
						</div>
						<h3 className="font-semibold mb-1">Görev Bulunamadı</h3>
						<p className="text-muted text-sm mb-4">
							{statusTab === "PENDING"
								? "Bekleyen uzun vadeli yatırım transfer görevi bulunmuyor."
								: statusTab === "SENT"
									? "Tamamlanmış transfer görevi bulunmuyor."
									: "İptal edilmiş transfer görevi bulunmuyor."}
						</p>
						{statusTab === "PENDING" && (
							<Link
								to="/long-term/new"
								className="btn btn-primary btn-sm"
								data-testid="create-first-task-btn"
							>
								<Plus size={16} aria-hidden="true" />
								<span>Yeni Transfer Görevi Oluştur</span>
							</Link>
						)}
					</div>
				) : (
					<div className="tasks-grid" data-testid="tasks-list">
						{allVisibleTasks.map((task) => (
							<Link
								key={task.taskId}
								to="/long-term/$taskId"
								params={{ taskId: task.taskId }}
								className="card task-card hover-lift block"
								aria-label={`${formatMoneyToTry(task.amount)} yatırım transfer detayı`}
								data-testid={`task-card-${task.taskId}`}
							>
								<div className="card-header flex justify-between items-start pb-2">
									<div className="flex-1 mr-2">
										<span
											className={`badge mb-1 ${
												task.status === "PENDING"
													? "badge-warning"
													: task.status === "SENT"
														? "badge-success"
														: "badge-secondary"
											}`}
											data-testid="task-card-status"
										>
											{task.status === "PENDING"
												? "Beklemede"
												: task.status === "SENT"
													? "Gönderildi"
													: "İptal Edildi"}
										</span>
										<div
											className="text-xl font-bold font-mono text-primary"
											data-testid="task-card-amount"
										>
											{formatMoneyToTry(task.amount)}
										</div>
										{task.destinationLabel && (
											<div
												className="text-sm font-medium text-foreground mt-1"
												data-testid="task-card-destination"
											>
												{task.destinationLabel}
											</div>
										)}
									</div>
									<ChevronRight
										size={18}
										className="text-muted shrink-0 mt-1"
										aria-hidden="true"
									/>
								</div>

								<div className="card-body pt-2 text-xs text-muted">
									<div className="flex items-center gap-1 mb-1">
										<Clock size={12} aria-hidden="true" />
										<span>
											Ayrıldı: {formatIstanbulDateTimeTurkish(task.allocatedAt)}
										</span>
									</div>
									{task.sentAt && (
										<div className="flex items-center gap-1 text-success">
											<CheckCircle2 size={12} aria-hidden="true" />
											<span>
												Gönderildi: {formatIstanbulDateTimeTurkish(task.sentAt)}
											</span>
										</div>
									)}
									{task.note && (
										<div className="task-card-note text-muted truncate mt-1">
											"{task.note}"
										</div>
									)}
								</div>
							</Link>
						))}
					</div>
				)}

				{hasMore && (
					<div className="pagination-footer mt-6 text-center">
						<button
							type="button"
							className="btn btn-secondary btn-sm"
							onClick={handleLoadMore}
							disabled={isFetching}
							data-testid="load-more-tasks-btn"
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
		</div>
	);
}

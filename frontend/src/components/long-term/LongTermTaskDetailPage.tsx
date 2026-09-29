import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	AlertCircle,
	ArrowLeft,
	CheckCircle2,
	Clock,
	RefreshCw,
	RotateCcw,
	XCircle,
} from "lucide-react";
import { useState } from "react";
import { ApiError } from "../../api/errors";
import { fetchLongTermTask } from "../../api/f7-api";
import { formatIstanbulDateTimeTurkish } from "../../lib/istanbul-date";
import { formatMoneyToTry } from "../../lib/money";
import {
	type LongTermActionType,
	LongTermLifecycleModal,
} from "./LongTermLifecycleModal";

interface LongTermTaskDetailPageProps {
	taskId: string;
}

export function LongTermTaskDetailPage({
	taskId,
}: LongTermTaskDetailPageProps) {
	const [activeAction, setActiveAction] = useState<LongTermActionType | null>(
		null,
	);

	const {
		data: taskData,
		isLoading,
		error,
		refetch,
		isFetching,
	} = useQuery({
		queryKey: ["long-term-task", taskId],
		queryFn: () => fetchLongTermTask(taskId),
		staleTime: 30_000,
	});

	const task = taskData?.task;

	if (isLoading) {
		return (
			<div className="page-container" data-testid="task-detail-loading">
				<div className="loading-state">
					<RefreshCw size={24} className="spin" aria-hidden="true" />
					<span>Görev bilgileri yükleniyor...</span>
				</div>
			</div>
		);
	}

	if (error || !task) {
		return (
			<div className="page-container" data-testid="task-detail-error">
				<div className="alert alert-danger" role="alert">
					<AlertCircle size={20} aria-hidden="true" />
					<div className="alert-content">
						<span>
							{error instanceof ApiError
								? error.userMessage
								: "Görev bulunamadı."}
						</span>
						<Link to="/long-term" className="btn btn-sm btn-secondary mt-2">
							Görev Listesine Dön
						</Link>
					</div>
				</div>
			</div>
		);
	}

	const isPending = task.status === "PENDING";
	const isSent = task.status === "SENT";
	const isCancelled = task.status === "CANCELLED";

	return (
		<div
			className="page-container long-term-task-detail-page"
			data-testid="long-term-task-detail-page"
		>
			{/* Breadcrumb / Back button */}
			<div className="mb-4">
				<Link
					to="/long-term"
					className="btn btn-ghost btn-sm"
					data-testid="back-to-long-term-btn"
				>
					<ArrowLeft size={16} aria-hidden="true" />
					<span>Tüm Yatırım Görevleri</span>
				</Link>
			</div>

			{/* Page Header */}
			<div className="page-header flex justify-between items-start">
				<div>
					<div className="flex items-center gap-2 mb-1">
						<span
							className={`badge ${
								isPending
									? "badge-warning"
									: isSent
										? "badge-success"
										: "badge-secondary"
							}`}
							data-testid="task-status-badge"
						>
							{isPending ? "Beklemede" : isSent ? "Gönderildi" : "İptal Edildi"}
						</span>
						<span className="text-xs text-muted">
							Revizyon #{task.revisionNo}
						</span>
					</div>
					<h1
						className="page-title text-2xl font-bold font-mono"
						data-testid="task-amount"
					>
						{formatMoneyToTry(task.amount)}
					</h1>
					{task.destinationLabel && (
						<p
							className="page-subtitle text-base font-medium text-foreground"
							data-testid="task-destination"
						>
							{task.destinationLabel}
						</p>
					)}
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
				</div>
			</div>

			{/* Task Overview Card */}
			<div className="card task-overview-card mb-6">
				<div className="card-header">
					<h2 className="card-title text-base">Transfer Detayları</h2>
				</div>
				<div className="card-body">
					<dl className="details-list">
						<div className="details-row">
							<dt className="details-term">Tutar</dt>
							<dd className="details-def font-mono font-bold text-primary">
								{formatMoneyToTry(task.amount)}
							</dd>
						</div>

						{task.destinationLabel && (
							<div className="details-row">
								<dt className="details-term">Hedef Kurum / Platform</dt>
								<dd className="details-def font-medium">
									{task.destinationLabel}
								</dd>
							</div>
						)}

						<div className="details-row">
							<dt className="details-term">Midas İçi Ayrılma Zamanı</dt>
							<dd className="details-def flex items-center gap-2">
								<Clock size={16} className="text-muted" aria-hidden="true" />
								<span data-testid="task-allocated-at">
									{formatIstanbulDateTimeTurkish(task.allocatedAt)}
								</span>
							</dd>
						</div>

						{task.sentAt && (
							<div className="details-row">
								<dt className="details-term">Dışarı Gönderilme Zamanı</dt>
								<dd className="details-def flex items-center gap-2 text-success font-medium">
									<CheckCircle2 size={16} aria-hidden="true" />
									<span data-testid="task-sent-at">
										{formatIstanbulDateTimeTurkish(task.sentAt)}
									</span>
								</dd>
							</div>
						)}

						{task.note && (
							<div className="details-row">
								<dt className="details-term">Not</dt>
								<dd className="details-def" data-testid="task-note">
									{task.note}
								</dd>
							</div>
						)}
					</dl>
				</div>
			</div>

			{/* Section 53-58: Lifecycle Action Bar */}
			<div className="card task-actions-card">
				<div className="card-header">
					<h2 className="card-title text-base">Durum & İşlemler</h2>
				</div>
				<div className="card-body">
					{isPending && (
						<div>
							<p className="text-sm text-muted mb-4">
								Tutar Midas içinde PENDING_LONG_TERM havuzunda ayrılmıştır.
								Parayı aracı kuruma veya yatırım hesabına fiziken
								gönderdiğinizde "Gönderildi Olarak İşaretle" butonuna tıklayın.
							</p>
							<div className="flex flex-col sm:flex-row gap-3">
								<button
									type="button"
									className="btn btn-primary"
									onClick={() => setActiveAction("mark-sent")}
									data-testid="mark-sent-btn"
								>
									<CheckCircle2 size={16} aria-hidden="true" />
									<span>Gönderildi Olarak İşaretle</span>
								</button>

								<button
									type="button"
									className="btn btn-danger-outline"
									onClick={() => setActiveAction("cancel")}
									data-testid="cancel-task-btn"
								>
									<XCircle size={16} aria-hidden="true" />
									<span>Görevi İptal Et (Serbeste İade)</span>
								</button>
							</div>
						</div>
					)}

					{isSent && (
						<div>
							<div className="alert alert-success mb-4" role="note">
								<CheckCircle2 size={18} aria-hidden="true" />
								<span>
									Bu yatırım transferi başarıyla tamamlanmış ve defter çıkış
									kaydı işlenmiştir.
								</span>
							</div>

							<div className="flex gap-3">
								<button
									type="button"
									className="btn btn-secondary"
									onClick={() => setActiveAction("reopen")}
									data-testid="reopen-task-btn"
								>
									<RotateCcw size={16} aria-hidden="true" />
									<span>Gönderimi Geri Aç (Düzeltme)</span>
								</button>
							</div>
						</div>
					)}

					{isCancelled && (
						<div
							className="text-muted text-sm"
							data-testid="task-cancelled-text"
						>
							Bu görev iptal edilmiş ve ayrılan bakiye Midas Serbest Bakiye'ye
							iade edilmiştir. Üzerinde başka bir işlem yapılamaz.
						</div>
					)}
				</div>
			</div>

			{/* Lifecycle Modal */}
			{activeAction && (
				<LongTermLifecycleModal
					isOpen={Boolean(activeAction)}
					onClose={() => setActiveAction(null)}
					task={task}
					actionType={activeAction}
					onSuccess={() => void refetch()}
				/>
			)}
		</div>
	);
}

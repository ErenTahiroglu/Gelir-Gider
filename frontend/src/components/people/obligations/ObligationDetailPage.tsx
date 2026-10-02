import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	AlertCircle,
	ArrowLeft,
	Ban,
	DollarSign,
	History,
	Info,
} from "lucide-react";
import { useRef, useState } from "react";
import { ApiError, isNetworkUncertainError } from "../../../api/errors";
import "../../../api/domain-errors";
import {
	fetchObligationSettlements,
	fetchPersonObligation,
	voidPersonObligation,
} from "../../../api/people-api";
import { formatIstanbulDateTimeTurkish } from "../../../lib/istanbul-date";
import { formatMoneyToTry } from "../../../lib/money";
import { PayableSettlementModal } from "./PayableSettlementModal";

interface ObligationDetailPageProps {
	personId: string;
	obligationId: string;
}

export function ObligationDetailPage({
	personId,
	obligationId,
}: ObligationDetailPageProps) {
	const queryClient = useQueryClient();

	const [isPayModalOpen, setIsPayModalOpen] = useState(false);
	const [voidError, setVoidError] = useState<string | null>(null);
	const [isVoidUncertain, setIsVoidUncertain] = useState(false);
	const frozenVoidAttemptRef = useRef<{
		key: string;
		expectedRevisionNo: number;
	} | null>(null);

	// 1. Fetch obligation
	const {
		data: obligationData,
		isLoading: isObligationLoading,
		error: obligationError,
	} = useQuery({
		queryKey: ["person-obligation", personId, obligationId],
		queryFn: () => fetchPersonObligation(personId, obligationId),
	});

	const obligation = obligationData?.obligation;

	// 2. Fetch settlements history with cursor pagination
	const {
		data: settlementsPages,
		isLoading: isSettlementsLoading,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	} = useInfiniteQuery({
		queryKey: ["person-settlements", personId, obligationId],
		queryFn: ({ pageParam }) =>
			fetchObligationSettlements(personId, obligationId, {
				limit: 50,
				after: pageParam ?? undefined,
			}),
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
	});

	const settlements =
		settlementsPages?.pages.flatMap((page) => page.settlements) ?? [];

	// 3. Void mutation
	const voidMutation = useMutation({
		mutationFn: async (attempt: {
			key: string;
			expectedRevisionNo: number;
		}) => {
			return voidPersonObligation(
				personId,
				obligationId,
				{ expectedRevisionNo: attempt.expectedRevisionNo },
				attempt.key,
			);
		},
		retry: false,
		onSuccess: () => {
			setIsVoidUncertain(false);
			frozenVoidAttemptRef.current = null;
			setVoidError(null);
			void queryClient.invalidateQueries({ queryKey: ["people"] });
			void queryClient.invalidateQueries({ queryKey: ["active-people"] });
			void queryClient.invalidateQueries({ queryKey: ["person", personId] });
			void queryClient.invalidateQueries({
				queryKey: ["person-balance-summary", personId],
			});
			void queryClient.invalidateQueries({
				queryKey: ["person-obligations", personId],
			});
			void queryClient.invalidateQueries({
				queryKey: ["person-obligation", personId, obligationId],
			});
			void queryClient.invalidateQueries({ queryKey: ["transactions"] });
			void queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] });
			void queryClient.invalidateQueries({ queryKey: ["spending-summary"] });
		},
		onError: (err) => {
			if (isNetworkUncertainError(err)) {
				setIsVoidUncertain(true);
				setVoidError(null);
				return;
			}
			setIsVoidUncertain(false);
			if (err instanceof ApiError) {
				setVoidError(err.userMessage);
			} else if (err instanceof Error) {
				setVoidError(err.message);
			} else {
				setVoidError("Kayıt iptal edilirken bir hata oluştu.");
			}
		},
	});

	const handleVoid = () => {
		if (!obligation) return;
		if (
			window.confirm(
				"Bu borç/alacak kaydını iptal etmek istediğinize emin misiniz?",
			)
		) {
			setVoidError(null);
			setIsVoidUncertain(false);
			const attempt = {
				key: crypto.randomUUID(),
				expectedRevisionNo: obligation.revisionNo,
			};
			frozenVoidAttemptRef.current = attempt;
			voidMutation.mutate(attempt);
		}
	};

	const handleRetryVoidUncertain = () => {
		if (!frozenVoidAttemptRef.current) return;
		setVoidError(null);
		voidMutation.mutate(frozenVoidAttemptRef.current);
	};

	if (isObligationLoading) {
		return (
			<div className="obligation-detail-page">
				<div className="loading-card card">
					<p>Kayıt detayları yükleniyor...</p>
				</div>
			</div>
		);
	}

	if (obligationError || !obligation) {
		return (
			<div className="obligation-detail-page">
				<div className="alert alert-danger">
					<AlertCircle size={18} aria-hidden="true" />
					<span>Kayıt bulunamadı veya bir hata oluştu.</span>
				</div>
				<Link
					to="/people/$personId"
					params={{ personId }}
					className="btn btn-secondary mt-3"
				>
					<ArrowLeft size={16} aria-hidden="true" />
					<span>Kişi Detayına Dön</span>
				</Link>
			</div>
		);
	}

	const isReceivable = obligation.direction === "RECEIVABLE";
	const isPayable = obligation.direction === "PAYABLE";
	const isOpen = obligation.status === "OPEN";

	return (
		<div
			className="obligation-detail-page"
			data-testid="obligation-detail-page"
		>
			{/* Back Link */}
			<div className="page-nav-header">
				<Link
					to="/people/$personId"
					params={{ personId }}
					className="back-link"
					data-testid="back-to-person-btn"
				>
					<ArrowLeft size={18} aria-hidden="true" />
					<span>Kişi Detayına Dön</span>
				</Link>
			</div>

			{voidError && (
				<div
					className="alert alert-danger"
					role="alert"
					data-testid="obligation-void-error"
				>
					<AlertCircle size={18} aria-hidden="true" />
					<span>{voidError}</span>
				</div>
			)}

			{isVoidUncertain && (
				<div
					className="alert alert-warning"
					role="alert"
					data-testid="obligation-void-uncertain-alert"
				>
					<AlertCircle size={18} aria-hidden="true" />
					<div>
						<p>İptal işleminin tamamlanıp tamamlanmadığı doğrulanamadı.</p>
						<button
							type="button"
							className="btn btn-secondary btn-sm mt-2"
							onClick={handleRetryVoidUncertain}
							disabled={voidMutation.isPending}
							data-testid="retry-uncertain-void-btn"
						>
							Aynı İptal İşlemini Tekrar Dene
						</button>
					</div>
				</div>
			)}

			{/* Main Summary Card */}
			<div className="obligation-summary-card card">
				<div className="obligation-header-row">
					<div className="obligation-title-block">
						<span
							className={`direction-badge ${isReceivable ? "receivable" : "payable"}`}
						>
							{isReceivable ? "Bana Ödeyecek" : "Ben Ödeyeceğim"}
						</span>
						<h1 className="obligation-principal-title">
							{formatMoneyToTry(obligation.principalAmount)}
						</h1>
					</div>

					<div className="obligation-status-block">
						<span
							className={`status-pill status-${obligation.status.toLowerCase()}`}
							data-testid="obligation-status-badge"
						>
							{obligation.status === "OPEN"
								? "Açık"
								: obligation.status === "SETTLED"
									? "Kapandı"
									: "İptal"}
						</span>
					</div>
				</div>

				{/* Split Managed Banner */}
				{obligation.isSplitManaged && (
					<div
						className="split-managed-banner alert alert-info"
						data-testid="split-managed-banner"
					>
						<Info size={18} aria-hidden="true" />
						<div className="split-banner-text">
							<strong>Kart bölüşümünden</strong>
							<p>
								Bu alacak kart harcaması bölüşümünden oluşturuldu. Tutarı
								değiştirmek için ilgili ortak harcamayı düzenleyin.
							</p>
						</div>
					</div>
				)}

				<div className="obligation-metrics-grid">
					<div className="metric-box">
						<span className="metric-label">Ödenen / Tahsil Edilen</span>
						<span className="metric-value">
							{formatMoneyToTry(obligation.settledAmount)}
						</span>
					</div>

					<div className="metric-box">
						<span className="metric-label">Kalan Tutar</span>
						<span className="metric-value highlight-remaining">
							{formatMoneyToTry(obligation.remainingAmount)}
						</span>
					</div>

					{obligation.dueDate && (
						<div className="metric-box">
							<span className="metric-label">Vade Tarihi</span>
							<span className="metric-value">{obligation.dueDate}</span>
						</div>
					)}

					{obligation.budgetCategory && (
						<div className="metric-box">
							<span className="metric-label">Harcama Sınıfı</span>
							<span className="metric-value">
								{obligation.budgetCategory === "MANDATORY_EXPENSE"
									? "Zorunlu Temel İhtiyaç"
									: obligation.budgetCategory === "DISCRETIONARY_SPEND"
										? "Keyfi / Esnek Harcama"
										: obligation.budgetCategory === "SHORT_TERM_PURCHASE"
											? "Planlı Kısa Vadeli Alım"
											: obligation.budgetCategory}
							</span>
						</div>
					)}
				</div>

				{obligation.description && (
					<div className="obligation-description-box">
						<span className="info-label">Açıklama:</span>
						<p className="description-text">{obligation.description}</p>
					</div>
				)}

				{/* Obligation Actions */}
				{isOpen && (
					<div className="obligation-actions-row">
						{/* If OPEN PAYABLE, show Borcu Öde */}
						{isPayable && (
							<button
								type="button"
								className="btn btn-primary"
								onClick={() => setIsPayModalOpen(true)}
								data-testid="settle-payable-btn"
							>
								<DollarSign size={16} aria-hidden="true" />
								<span>Borcu Öde</span>
							</button>
						)}

						{/* Void button for standalone OPEN obligations */}
						{!obligation.isSplitManaged && (
							<button
								type="button"
								className="btn btn-outline-danger"
								onClick={handleVoid}
								disabled={voidMutation.isPending || isVoidUncertain}
								data-testid="void-obligation-btn"
							>
								<Ban size={16} aria-hidden="true" />
								<span>
									{voidMutation.isPending
										? "İptal Ediliyor..."
										: "Kaydı İptal Et"}
								</span>
							</button>
						)}
					</div>
				)}
			</div>

			{/* Settlements History Section */}
			<div className="settlements-history-section card">
				<div className="section-header">
					<History size={18} aria-hidden="true" />
					<h2 className="section-title">Ödeme Geçmişi</h2>
				</div>

				{isSettlementsLoading ? (
					<p className="text-secondary">Ödeme geçmişi yükleniyor...</p>
				) : settlements.length === 0 ? (
					<div
						className="empty-state text-secondary"
						data-testid="empty-settlements"
					>
						Bu borç/alacak kaydı için henüz yapılmış bir ödeme bulunmuyor.
					</div>
				) : (
					<div className="settlements-table-wrapper">
						<table
							className="data-table settlements-table"
							data-testid="settlements-history-table"
						>
							<thead>
								<tr>
									<th>Tarih</th>
									<th>Toplam Ödenen</th>
									<th>Uygulanan</th>
									<th>Fazla Tutar</th>
									<th>Not</th>
									<th>Durum</th>
								</tr>
							</thead>
							<tbody>
								{settlements.map((s) => (
									<tr
										key={s.settlementId}
										data-testid={`settlement-row-${s.settlementId}`}
									>
										<td>{formatIstanbulDateTimeTurkish(s.occurredAt)}</td>
										<td>{formatMoneyToTry(s.cashAmount)}</td>
										<td>{formatMoneyToTry(s.appliedAmount)}</td>
										<td>{formatMoneyToTry(s.excessAmount)}</td>
										<td>{s.note ?? "-"}</td>
										<td>
											<span
												className={`status-pill status-${s.status.toLowerCase()}`}
											>
												{s.status === "ACTIVE" ? "Aktif" : "İptal"}
											</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>

						{hasNextPage && (
							<div className="load-more-container">
								<button
									type="button"
									className="btn btn-secondary btn-sm"
									onClick={() => void fetchNextPage()}
									disabled={isFetchingNextPage}
									data-testid="load-more-settlements-btn"
								>
									{isFetchingNextPage
										? "Yükleniyor..."
										: "Daha Fazla Ödeme Göster"}
								</button>
							</div>
						)}
					</div>
				)}
			</div>

			{/* Payable Settlement Modal */}
			{isPayModalOpen && (
				<PayableSettlementModal
					isOpen={isPayModalOpen}
					onClose={() => setIsPayModalOpen(false)}
					personId={personId}
					obligation={obligation}
				/>
			)}
		</div>
	);
}

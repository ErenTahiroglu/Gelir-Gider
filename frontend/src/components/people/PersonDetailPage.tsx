import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
	AlertCircle,
	Archive,
	ArrowDownRight,
	ArrowLeft,
	ArrowUpRight,
	Coins,
	Edit,
	Plus,
	User,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
	fetchPerson,
	fetchPersonBalanceSummary,
	fetchPersonObligations,
} from "../../api/people-api";
import type {
	ObligationProductDto,
	PersonObligationDirection,
	PersonObligationStatus,
	PersonRelationship,
} from "../../api/people-types";
import { formatMoneyToTry, parseMoneyToCents } from "../../lib/money";
import { PersonArchiveModal } from "./PersonArchiveModal";

interface PersonDetailPageProps {
	personId: string;
}

export function PersonDetailPage({ personId }: PersonDetailPageProps) {
	const navigate = useNavigate();

	const [isArchiveModalOpen, setIsArchiveModalOpen] = useState(false);
	const [directionFilter, setDirectionFilter] = useState<
		PersonObligationDirection | "ALL"
	>("ALL");
	const [statusFilter, setStatusFilter] = useState<
		PersonObligationStatus | "ALL"
	>("ALL");

	// 1. Parallel query: Person details
	const {
		data: personData,
		isLoading: isPersonLoading,
		error: personError,
	} = useQuery({
		queryKey: ["person", personId],
		queryFn: () => fetchPerson(personId),
	});

	// 2. Parallel query: Balance summary
	const {
		data: balanceSummary,
		isLoading: isSummaryLoading,
		error: summaryError,
	} = useQuery({
		queryKey: ["person-balance-summary", personId],
		queryFn: () => fetchPersonBalanceSummary(personId),
	});

	// 3. Parallel query: Obligations with infinite cursor pagination
	const {
		data: obligationsPages,
		isLoading: isObligationsLoading,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	} = useInfiniteQuery({
		queryKey: ["person-obligations", personId, directionFilter, statusFilter],
		queryFn: ({ pageParam }) =>
			fetchPersonObligations(personId, {
				direction: directionFilter === "ALL" ? undefined : directionFilter,
				status: statusFilter === "ALL" ? undefined : statusFilter,
				limit: 50,
				after: pageParam ?? undefined,
			}),
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
	});

	const person = personData?.person;
	const obligations = useMemo(
		() => obligationsPages?.pages.flatMap((page) => page.obligations) ?? [],
		[obligationsPages],
	);

	if (isPersonLoading || isSummaryLoading) {
		return (
			<div className="person-detail-page">
				<div className="card loading-card">
					<p>Kişi bilgileri yükleniyor...</p>
				</div>
			</div>
		);
	}

	if (personError || !person || summaryError || !balanceSummary) {
		return (
			<div className="person-detail-page">
				<div className="alert alert-danger">
					<AlertCircle size={18} aria-hidden="true" />
					<span>Kişi bilgileri yüklenemedi veya kişi bulunamadı.</span>
				</div>
				<Link to="/people" className="btn btn-secondary mt-3">
					<ArrowLeft size={16} aria-hidden="true" />
					<span>Kişilere Dön</span>
				</Link>
			</div>
		);
	}

	const relationshipLabel: Record<PersonRelationship, string> = {
		FAMILY: "Aile",
		FRIEND: "Arkadaş",
		OTHER: "Diğer",
	};

	const hasReceivable =
		parseMoneyToCents(balanceSummary.exactReceivableBalance) > 0n;

	return (
		<div className="person-detail-page" data-testid="person-detail-page">
			{/* Back Link */}
			<div className="page-nav-header">
				<Link
					to="/people"
					className="back-link"
					data-testid="back-to-people-link"
				>
					<ArrowLeft size={18} aria-hidden="true" />
					<span>Kişiler</span>
				</Link>
			</div>

			{/* Person Header Card */}
			<div className="person-header-card card">
				<div className="person-header-main">
					<div className="person-avatar" aria-hidden="true">
						<User size={28} />
					</div>
					<div className="person-meta">
						<div className="person-title-row">
							<h1 className="person-name" data-testid="person-display-name">
								{person.displayName}
							</h1>
							<span
								className={`relationship-pill relationship-${person.relationship.toLowerCase()}`}
								data-testid="person-relationship-badge"
							>
								{relationshipLabel[person.relationship]}
							</span>
							{person.status === "ARCHIVED" && (
								<span className="status-pill status-archived">Arşivlendi</span>
							)}
						</div>
						{person.note && (
							<p className="person-note text-secondary">{person.note}</p>
						)}
					</div>
				</div>

				<div className="person-header-actions">
					<Link
						to="/people/$personId/edit"
						params={{ personId }}
						className="btn btn-secondary btn-sm"
						data-testid="edit-person-btn"
					>
						<Edit size={14} aria-hidden="true" />
						<span>Düzenle</span>
					</Link>

					{person.status === "ACTIVE" && (
						<button
							type="button"
							className="btn btn-outline-danger btn-sm"
							onClick={() => setIsArchiveModalOpen(true)}
							data-testid="archive-person-btn"
						>
							<Archive size={14} aria-hidden="true" />
							<span>Arşivle</span>
						</button>
					)}
				</div>
			</div>

			{/* Balance Summary Cards (Never collapsed into a fake net) */}
			<div className="person-balances-grid" data-testid="person-balances-grid">
				{/* Card 1: Bana Ödeyecek */}
				<div
					className="balance-card receivable-card card"
					data-testid="receivable-balance-card"
				>
					<div className="balance-card-header">
						<span className="balance-label">Bana Ödeyecek</span>
						<ArrowDownRight
							size={20}
							className="balance-icon receivable-icon"
							aria-hidden="true"
						/>
					</div>

					<div className="balance-card-body">
						{/* FRIEND collection target display per Section 6 */}
						{balanceSummary.relationship === "FRIEND" &&
						balanceSummary.collectionTarget ? (
							<div className="friend-target-block">
								<div className="target-row">
									<span className="target-label">Önerilen Tahsilat</span>
									<span
										className="target-amount highlight-target"
										data-testid="summary-collection-target"
									>
										{formatMoneyToTry(balanceSummary.collectionTarget)}
									</span>
								</div>
								<div className="exact-row text-secondary">
									<span>Gerçek Alacak: </span>
									<span data-testid="summary-exact-receivable">
										{formatMoneyToTry(balanceSummary.exactReceivableBalance)}
									</span>
								</div>
							</div>
						) : (
							/* FAMILY / OTHER display exact amount directly per Section 7 */
							<div className="exact-balance-block">
								<span
									className="exact-amount"
									data-testid="summary-exact-receivable"
								>
									{formatMoneyToTry(balanceSummary.exactReceivableBalance)}
								</span>
							</div>
						)}
					</div>

					<div className="balance-card-footer">
						<Link
							to="/people/$personId/settle"
							params={{ personId }}
							className={`btn btn-primary btn-sm ${!hasReceivable ? "disabled" : ""}`}
							aria-disabled={!hasReceivable}
							data-testid="settle-receivables-action-btn"
						>
							<Coins size={14} aria-hidden="true" />
							<span>Ödeme Al</span>
						</Link>
					</div>
				</div>

				{/* Card 2: Ben Ödeyeceğim */}
				<div
					className="balance-card payable-card card"
					data-testid="payable-balance-card"
				>
					<div className="balance-card-header">
						<span className="balance-label">Ben Ödeyeceğim</span>
						<ArrowUpRight
							size={20}
							className="balance-icon payable-icon"
							aria-hidden="true"
						/>
					</div>

					<div className="balance-card-body">
						<span
							className="exact-amount payable-amount"
							data-testid="summary-exact-payable"
						>
							{formatMoneyToTry(balanceSummary.exactPayableBalance)}
						</span>
					</div>

					<div className="balance-card-footer text-secondary">
						<span>Borç ödemesini aşağıdaki kayıtlardan yapabilirsiniz.</span>
					</div>
				</div>
			</div>

			{/* Obligations Action Bar */}
			<div className="obligations-action-bar">
				<div className="bar-title-block">
					<h2 className="bar-title">Borç & Alacak Kayıtları</h2>
				</div>
				<div className="bar-actions">
					<Link
						to="/people/$personId/obligations/new"
						params={{ personId }}
						search={{ direction: "RECEIVABLE" }}
						className="btn btn-outline-success btn-sm"
						data-testid="create-receivable-btn"
					>
						<Plus size={14} aria-hidden="true" />
						<span>Borç Verdim</span>
					</Link>
					<Link
						to="/people/$personId/obligations/new"
						params={{ personId }}
						search={{ direction: "PAYABLE" }}
						className="btn btn-outline-warning btn-sm"
						data-testid="create-payable-btn"
					>
						<Plus size={14} aria-hidden="true" />
						<span>Borçlandım</span>
					</Link>
				</div>
			</div>

			{/* Obligations Filters */}
			<div className="obligations-filters-bar card">
				<div className="filter-group">
					<span className="filter-label">Tür:</span>
					<button
						type="button"
						className={`filter-btn ${directionFilter === "ALL" ? "active" : ""}`}
						onClick={() => setDirectionFilter("ALL")}
						data-testid="filter-dir-all"
					>
						Tümü
					</button>
					<button
						type="button"
						className={`filter-btn ${directionFilter === "RECEIVABLE" ? "active" : ""}`}
						onClick={() => setDirectionFilter("RECEIVABLE")}
						data-testid="filter-dir-receivable"
					>
						Bana Ödeyecek
					</button>
					<button
						type="button"
						className={`filter-btn ${directionFilter === "PAYABLE" ? "active" : ""}`}
						onClick={() => setDirectionFilter("PAYABLE")}
						data-testid="filter-dir-payable"
					>
						Ben Ödeyeceğim
					</button>
				</div>

				<div className="filter-group">
					<span className="filter-label">Durum:</span>
					<button
						type="button"
						className={`filter-btn ${statusFilter === "ALL" ? "active" : ""}`}
						onClick={() => setStatusFilter("ALL")}
						data-testid="filter-status-all"
					>
						Tümü
					</button>
					<button
						type="button"
						className={`filter-btn ${statusFilter === "OPEN" ? "active" : ""}`}
						onClick={() => setStatusFilter("OPEN")}
						data-testid="filter-status-open"
					>
						Açık
					</button>
					<button
						type="button"
						className={`filter-btn ${statusFilter === "SETTLED" ? "active" : ""}`}
						onClick={() => setStatusFilter("SETTLED")}
						data-testid="filter-status-settled"
					>
						Kapandı
					</button>
					<button
						type="button"
						className={`filter-btn ${statusFilter === "VOID" ? "active" : ""}`}
						onClick={() => setStatusFilter("VOID")}
						data-testid="filter-status-void"
					>
						İptal
					</button>
				</div>
			</div>

			{/* Obligations List */}
			<div className="obligations-list-container">
				{isObligationsLoading ? (
					<p className="text-secondary">Kayıtlar yükleniyor...</p>
				) : obligations.length === 0 ? (
					<div
						className="empty-state card text-secondary"
						data-testid="empty-obligations"
					>
						Filtreye uygun borç veya alacak kaydı bulunamadı.
					</div>
				) : (
					<div className="obligations-grid">
						{obligations.map((ob: ObligationProductDto) => {
							const isRec = ob.direction === "RECEIVABLE";
							const isSplit = ob.isSplitManaged;

							return (
								<Link
									key={ob.obligationId}
									to="/people/$personId/obligations/$obligationId"
									params={{ personId, obligationId: ob.obligationId }}
									className="obligation-card card"
									data-testid={`obligation-card-${ob.obligationId}`}
								>
									<div className="obligation-card-top">
										<span
											className={`direction-badge ${isRec ? "receivable" : "payable"}`}
										>
											{isRec ? "Bana Ödeyecek" : "Ben Ödeyeceğim"}
										</span>
										<span
											className={`status-pill status-${ob.status.toLowerCase()}`}
										>
											{ob.status === "OPEN"
												? "Açık"
												: ob.status === "SETTLED"
													? "Kapandı"
													: "İptal"}
										</span>
									</div>

									<div className="obligation-card-body">
										<div className="amount-row">
											<span className="principal-amount">
												{formatMoneyToTry(ob.principalAmount)}
											</span>
											{ob.status === "OPEN" && (
												<span className="remaining-amount">
													Kalan: {formatMoneyToTry(ob.remainingAmount)}
												</span>
											)}
										</div>

										{ob.description && (
											<p className="obligation-desc">{ob.description}</p>
										)}

										<div className="obligation-footer-tags">
											{ob.dueDate && (
												<span className="tag-item">Vade: {ob.dueDate}</span>
											)}
											{isSplit && (
												<span
													className="badge badge-info"
													data-testid="badge-split-managed"
												>
													Kart bölüşümünden
												</span>
											)}
										</div>
									</div>
								</Link>
							);
						})}
					</div>
				)}

				{hasNextPage && (
					<div className="load-more-container">
						<button
							type="button"
							className="btn btn-secondary btn-sm"
							onClick={() => void fetchNextPage()}
							disabled={isFetchingNextPage}
							data-testid="load-more-obligations-btn"
						>
							{isFetchingNextPage ? "Yükleniyor..." : "Daha Fazla Göster"}
						</button>
					</div>
				)}
			</div>

			{/* Person Archive Modal */}
			{isArchiveModalOpen && person && (
				<PersonArchiveModal
					isOpen={isArchiveModalOpen}
					onClose={() => setIsArchiveModalOpen(false)}
					person={person}
					onSuccess={() => void navigate({ to: "/people" })}
				/>
			)}
		</div>
	);
}

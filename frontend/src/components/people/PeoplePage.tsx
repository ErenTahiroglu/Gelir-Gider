import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertCircle, Plus, Users } from "lucide-react";
import { useMemo, useState } from "react";
import "../../api/domain-errors";
import { fetchPeople } from "../../api/people-api";
import type {
	PersonProductDto,
	PersonRelationship,
	PersonStatus,
} from "../../api/people-types";
import { formatMoneyToTry } from "../../lib/money";

export function PeoplePage() {
	const [statusFilter, setStatusFilter] = useState<PersonStatus | "ALL">(
		"ACTIVE",
	);
	const [relationshipFilter, setRelationshipFilter] = useState<
		PersonRelationship | "ALL"
	>("ALL");

	// Keyset cursor pagination with useInfiniteQuery per Section 13
	const {
		data: peoplePages,
		isLoading,
		error,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	} = useInfiniteQuery({
		queryKey: ["people", statusFilter, relationshipFilter],
		queryFn: ({ pageParam }) =>
			fetchPeople({
				status: statusFilter === "ALL" ? undefined : statusFilter,
				relationship:
					relationshipFilter === "ALL" ? undefined : relationshipFilter,
				limit: 50,
				after: pageParam ?? undefined,
			}),
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
	});

	const people = useMemo(
		() => peoplePages?.pages.flatMap((page) => page.people) ?? [],
		[peoplePages],
	);

	const relationshipLabels: Record<PersonRelationship, string> = {
		FAMILY: "Aile",
		FRIEND: "Arkadaş",
		OTHER: "Diğer",
	};

	return (
		<div className="people-page" data-testid="people-page">
			{/* Page Header */}
			<div className="page-header">
				<div className="header-title-block">
					<h1 className="page-title">Kişiler</h1>
					<p className="page-subtitle">
						Borç, alacak ve tahsilat takibi yaptığınız kişiler.
					</p>
				</div>
				<div className="header-actions">
					<Link
						to="/people/new"
						className="btn btn-primary"
						data-testid="add-person-btn"
					>
						<Plus size={16} aria-hidden="true" />
						<span>Yeni Kişi Ekle</span>
					</Link>
				</div>
			</div>

			{/* Filters Bar */}
			<div className="people-filters-bar card">
				<div className="filter-group">
					<span className="filter-label">Durum:</span>
					<button
						type="button"
						className={`filter-btn ${statusFilter === "ACTIVE" ? "active" : ""}`}
						onClick={() => setStatusFilter("ACTIVE")}
						data-testid="filter-status-active"
					>
						Aktif
					</button>
					<button
						type="button"
						className={`filter-btn ${statusFilter === "ARCHIVED" ? "active" : ""}`}
						onClick={() => setStatusFilter("ARCHIVED")}
						data-testid="filter-status-archived"
					>
						Arşivlenmiş
					</button>
					<button
						type="button"
						className={`filter-btn ${statusFilter === "ALL" ? "active" : ""}`}
						onClick={() => setStatusFilter("ALL")}
						data-testid="filter-status-all"
					>
						Tümü
					</button>
				</div>

				<div className="filter-group">
					<span className="filter-label">İlişki:</span>
					<button
						type="button"
						className={`filter-btn ${relationshipFilter === "ALL" ? "active" : ""}`}
						onClick={() => setRelationshipFilter("ALL")}
						data-testid="filter-rel-all"
					>
						Tümü
					</button>
					<button
						type="button"
						className={`filter-btn ${relationshipFilter === "FRIEND" ? "active" : ""}`}
						onClick={() => setRelationshipFilter("FRIEND")}
						data-testid="filter-rel-friend"
					>
						Arkadaş
					</button>
					<button
						type="button"
						className={`filter-btn ${relationshipFilter === "FAMILY" ? "active" : ""}`}
						onClick={() => setRelationshipFilter("FAMILY")}
						data-testid="filter-rel-family"
					>
						Aile
					</button>
					<button
						type="button"
						className={`filter-btn ${relationshipFilter === "OTHER" ? "active" : ""}`}
						onClick={() => setRelationshipFilter("OTHER")}
						data-testid="filter-rel-other"
					>
						Diğer
					</button>
				</div>
			</div>

			{/* Error State */}
			{error && (
				<div className="alert alert-danger" role="alert">
					<AlertCircle size={18} aria-hidden="true" />
					<span>Kişiler yüklenirken bir hata oluştu.</span>
				</div>
			)}

			{/* Loading State */}
			{isLoading ? (
				<div className="people-loading card">
					<p>Kişiler yükleniyor...</p>
				</div>
			) : people.length === 0 ? (
				<div
					className="people-empty card text-secondary"
					data-testid="empty-people"
				>
					<Users size={32} aria-hidden="true" className="empty-icon" />
					<p>Kayıtlı kişi bulunamadı.</p>
					<Link to="/people/new" className="btn btn-secondary btn-sm mt-2">
						İlk Kişiyi Ekle
					</Link>
				</div>
			) : (
				<>
					{/* Mobile Card List View (Section 15) */}
					<div className="people-mobile-list" data-testid="people-mobile-list">
						{people.map((person: PersonProductDto) => (
							<Link
								key={person.personId}
								to="/people/$personId"
								params={{ personId: person.personId }}
								className="person-mobile-card card"
								data-testid={`person-card-${person.personId}`}
							>
								<div className="card-top-row">
									<div className="person-identity">
										<span className="person-name">{person.displayName}</span>
										<span
											className={`relationship-pill relationship-${person.relationship.toLowerCase()}`}
										>
											{relationshipLabels[person.relationship]}
										</span>
									</div>
									{person.status === "ARCHIVED" && (
										<span className="status-pill status-archived">Arşiv</span>
									)}
								</div>

								<div className="card-balances-row">
									<div className="balance-item receivable-item">
										<span className="balance-item-label">Bana Ödeyecek</span>
										<span className="balance-item-value">
											{formatMoneyToTry(person.receivableBalance)}
										</span>
									</div>

									<div className="balance-item payable-item">
										<span className="balance-item-label">Ben Ödeyeceğim</span>
										<span className="balance-item-value">
											{formatMoneyToTry(person.payableBalance)}
										</span>
									</div>
								</div>
							</Link>
						))}
					</div>

					{/* Desktop Table View (Section 16) */}
					<div
						className="people-desktop-table-wrapper card"
						data-testid="people-desktop-table"
					>
						<table className="data-table people-table">
							<thead>
								<tr>
									<th>Kişi</th>
									<th>İlişki</th>
									<th>Bana Ödeyecek</th>
									<th>Ben Ödeyeceğim</th>
									<th>Durum</th>
								</tr>
							</thead>
							<tbody>
								{people.map((person: PersonProductDto) => (
									<tr
										key={person.personId}
										className="clickable-row"
										data-testid={`person-row-${person.personId}`}
									>
										<td>
											<Link
												to="/people/$personId"
												params={{ personId: person.personId }}
												className="table-person-link"
											>
												<span className="table-person-name">
													{person.displayName}
												</span>
												{person.note && (
													<span className="table-person-note text-secondary">
														{person.note}
													</span>
												)}
											</Link>
										</td>
										<td>
											<span
												className={`relationship-pill relationship-${person.relationship.toLowerCase()}`}
											>
												{relationshipLabels[person.relationship]}
											</span>
										</td>
										<td className="amount-cell receivable-cell">
											{formatMoneyToTry(person.receivableBalance)}
										</td>
										<td className="amount-cell payable-cell">
											{formatMoneyToTry(person.payableBalance)}
										</td>
										<td>
											<span
												className={`status-pill status-${person.status.toLowerCase()}`}
											>
												{person.status === "ACTIVE" ? "Aktif" : "Arşiv"}
											</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>

					{/* Cursor Pagination Load More */}
					{hasNextPage && (
						<div className="load-more-container">
							<button
								type="button"
								className="btn btn-secondary"
								onClick={() => void fetchNextPage()}
								disabled={isFetchingNextPage}
								data-testid="load-more-people-btn"
							>
								{isFetchingNextPage
									? "Yükleniyor..."
									: "Daha Fazla Kişi Göster"}
							</button>
						</div>
					)}
				</>
			)}
		</div>
	);
}

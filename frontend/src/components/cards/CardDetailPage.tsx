/**
 * Card Detail Page (/cards/$cardId)
 *
 * Implements Section 6 & 8:
 *   - Standalone card view for mobile / direct navigation
 *   - Shows card metrics, statements list, purchases list
 *   - Edit & Archive actions
 */

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Archive, ArrowLeft, Edit3, Plus } from "lucide-react";
import { useState } from "react";
import { fetchCreditCard } from "../../api/credit-cards-api";
import { formatMoneyToTry } from "../../lib/money";
import { CardArchiveModal } from "./CardArchiveModal";
import { PurchaseList } from "./purchases/PurchaseList";
import { StatementList } from "./statements/StatementList";

export interface CardDetailPageProps {
	cardId: string;
}

export function CardDetailPage({ cardId }: CardDetailPageProps) {
	const navigate = useNavigate();
	const [archiveModalOpen, setArchiveModalOpen] = useState<boolean>(false);

	const {
		data: cardData,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["credit-card", cardId],
		queryFn: () => fetchCreditCard(cardId),
	});

	const card = cardData?.card;

	if (isLoading) {
		return (
			<div className="page-container" style={{ padding: "2rem" }}>
				<p style={{ color: "var(--color-text-muted)" }}>
					Kart bilgileri yükleniyor...
				</p>
			</div>
		);
	}

	if (error || !card) {
		return (
			<div className="page-container" style={{ padding: "2rem" }}>
				<div className="error-alert" role="alert">
					Kart bulunamadı veya yüklenirken bir hata oluştu.
				</div>
				<Link
					to="/cards"
					className="btn btn-secondary"
					style={{ marginTop: "1rem" }}
				>
					<ArrowLeft size={16} aria-hidden="true" />
					<span>Kartlar Listesine Dön</span>
				</Link>
			</div>
		);
	}

	return (
		<div className="page-container" data-testid="card-detail-page">
			<div className="page-header" style={{ marginBottom: "1.5rem" }}>
				<Link
					to="/cards"
					className="btn-back"
					style={{
						display: "inline-flex",
						alignItems: "center",
						gap: "0.5rem",
						color: "var(--color-text-muted, #64748b)",
						textDecoration: "none",
						marginBottom: "0.75rem",
						fontSize: "0.9rem",
					}}
				>
					<ArrowLeft size={16} aria-hidden="true" />
					<span>Tüm Kartlara Dön</span>
				</Link>

				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						flexWrap: "wrap",
						gap: "0.75rem",
					}}
				>
					<div>
						<h1 className="page-title" style={{ margin: 0 }}>
							{card.displayName}
						</h1>
						<div
							style={{
								fontSize: "0.85rem",
								color: "var(--color-text-muted, #64748b)",
								marginTop: "0.25rem",
							}}
						>
							{card.issuer}
							{card.lastFour ? ` •••• ${card.lastFour}` : ""} • Kod:{" "}
							<code>{card.code}</code>
						</div>
					</div>

					<div style={{ display: "flex", gap: "0.5rem" }}>
						<Link
							to="/cards/$cardId/edit"
							params={{ cardId: card.cardId }}
							className="btn btn-secondary btn-sm"
							data-testid="detail-edit-card-btn"
						>
							<Edit3 size={15} aria-hidden="true" />
							<span>Düzenle</span>
						</Link>

						<button
							type="button"
							className="btn btn-secondary btn-sm text-danger"
							onClick={() => setArchiveModalOpen(true)}
							data-testid="detail-archive-card-btn"
						>
							<Archive size={15} aria-hidden="true" />
							<span>Arşivle</span>
						</button>
					</div>
				</div>
			</div>

			{/* Metrics Overview Card */}
			<div
				className="card"
				style={{
					padding: "1.25rem",
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
					gap: "1rem",
					marginBottom: "1.5rem",
				}}
			>
				<div>
					<div style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
						Güncel Kart Borcu
					</div>
					<div
						style={{ fontSize: "1.5rem", fontWeight: 700 }}
						data-testid="card-detail-live-liability"
					>
						{formatMoneyToTry(card.liveLiabilityBalance || "0.00")}
					</div>
				</div>

				<div>
					<div style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
						Kredi Limiti
					</div>
					<div
						style={{
							fontSize: "1.2rem",
							fontWeight: 600,
							color: "var(--color-text-muted, #64748b)",
						}}
					>
						{formatMoneyToTry(card.creditLimit)}
					</div>
				</div>

				<div>
					<div style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
						Hesap Kesim / Son Ödeme
					</div>
					<div style={{ fontSize: "1rem", fontWeight: 500 }}>
						Her ayın {card.statementDay}. / {card.dueDay}. günü
					</div>
				</div>
			</div>

			{/* Sub-sections: Statements & Purchases */}
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
					gap: "1.5rem",
				}}
			>
				<div className="card" style={{ padding: "1.25rem" }}>
					<StatementList
						cardId={card.cardId}
						cardName={card.displayName}
						onNewStatement={() =>
							void navigate({
								to: "/cards/$cardId/statements/new",
								params: { cardId: card.cardId },
							})
						}
					/>
				</div>

				<div className="card" style={{ padding: "1.25rem" }}>
					<PurchaseList
						cardId={card.cardId}
						cardName={card.displayName}
						onNewPurchase={() =>
							void navigate({
								to: "/cards/$cardId/purchases/new",
								params: { cardId: card.cardId },
							})
						}
					/>
				</div>
			</div>

			{archiveModalOpen && (
				<CardArchiveModal
					isOpen={archiveModalOpen}
					card={card}
					onClose={() => setArchiveModalOpen(false)}
					onSuccess={() => void navigate({ to: "/cards" })}
				/>
			)}
		</div>
	);
}

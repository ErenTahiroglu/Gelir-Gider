/**
 * Cards OS Main Page (/cards)
 *
 * Implements Section 8, 9, 10:
 *   - Mobile: answers liability, nearest open statement, due date, reserve state, payment readiness
 *   - Desktop: 3-column OS layout (LEFT: Card Selector, CENTER: Selected Card & Statements, RIGHT: Recent Purchases)
 *   - Uses authoritative server dates
 *   - Medium density, no fake charts/analytics
 */

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Archive, CreditCard as CardIcon, Edit3, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import "../../api/domain-errors";
import {
	fetchAllActiveCreditCards,
	fetchCreditCardStatements,
} from "../../api/credit-cards-api";
import type {
	CreditCardItem,
	CreditCardStatementItem,
} from "../../api/credit-cards-types";
import { formatMoneyToTry } from "../../lib/money";
import { CardArchiveModal } from "./CardArchiveModal";
import { PurchaseList } from "./purchases/PurchaseList";
import { StatementList } from "./statements/StatementList";
import { StatementPayModal } from "./statements/StatementPayModal";

export function CardsPage() {
	const navigate = useNavigate();

	const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
	const [archiveCard, setArchiveCard] = useState<CreditCardItem | null>(null);
	const [payStatement, setPayStatement] =
		useState<CreditCardStatementItem | null>(null);

	// Load all active cards
	const {
		data: cards,
		isLoading: cardsLoading,
		error: cardsError,
	} = useQuery({
		queryKey: ["active-credit-cards"],
		queryFn: () => fetchAllActiveCreditCards(100),
	});

	const cardList: CreditCardItem[] = Array.isArray(cards)
		? cards
		: ((cards as unknown as { cards?: CreditCardItem[] })?.cards ?? []);

	// Automatically select first card if none selected
	useEffect(() => {
		if (!selectedCardId && cardList.length > 0 && cardList[0]) {
			setSelectedCardId(cardList[0].cardId);
		}
	}, [selectedCardId, cardList]);

	const selectedCard = cardList.find((c) => c.cardId === selectedCardId);

	// Load statements for selected card to find nearest OPEN statement
	const { data: statementsData } = useQuery({
		queryKey: ["card-statements", selectedCardId, { status: "OPEN" }],
		queryFn: () =>
			selectedCardId
				? fetchCreditCardStatements(selectedCardId, {
						status: "OPEN",
						limit: 5,
					})
				: Promise.resolve({ statements: [], nextCursor: null }),
		enabled: Boolean(selectedCardId),
	});

	const openStatements = statementsData?.statements ?? [];
	const nearestOpenStatement = openStatements[0];

	return (
		<div className="cards-os-container" data-testid="cards-page">
			{/* Page Header */}
			<div
				className="cards-page-header"
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					marginBottom: "1.5rem",
				}}
			>
				<div>
					<h1 className="page-title" style={{ margin: 0 }}>
						Kredi Kartları
					</h1>
					<p
						style={{
							margin: "0.25rem 0 0 0",
							color: "var(--color-text-muted, #64748b)",
							fontSize: "0.9rem",
						}}
					>
						Kart borçları, ekstreler ve harcama yönetimi
					</p>
				</div>

				<Link
					to="/cards/new"
					className="btn btn-primary"
					data-testid="new-card-button"
				>
					<Plus size={18} aria-hidden="true" />
					<span>Yeni Kart</span>
				</Link>
			</div>

			{cardsLoading ? (
				<div style={{ padding: "2rem", textAlign: "center" }}>
					<p style={{ color: "var(--color-text-muted)" }}>
						Kartlar yükleniyor...
					</p>
				</div>
			) : cardsError ? (
				<div className="error-alert" role="alert">
					Kartlar yüklenirken bir hata oluştu.
				</div>
			) : cardList.length === 0 ? (
				<div
					className="card empty-cards-card"
					style={{ padding: "3rem", textAlign: "center" }}
					data-testid="no-cards-container"
				>
					<CardIcon
						size={48}
						style={{ color: "var(--color-text-muted)", marginBottom: "1rem" }}
						aria-hidden="true"
					/>
					<h3 style={{ margin: "0 0 0.5rem 0" }}>Kayıtlı Kredi Kartı Yok</h3>
					<p
						style={{ color: "var(--color-text-muted)", marginBottom: "1.5rem" }}
					>
						Harcamalarınızı ve ekstrelerinizi yönetmek için ilk kartınızı
						ekleyin.
					</p>
					<Link
						to="/cards/new"
						className="btn btn-primary"
						data-testid="empty-new-card-btn"
					>
						<Plus size={18} aria-hidden="true" />
						<span>İlk Kartını Ekle</span>
					</Link>
				</div>
			) : (
				<>
					{/* Mobile Cards View (Section 9) */}
					<div className="mobile-cards-view" data-testid="mobile-cards-view">
						<div
							className="mobile-card-list"
							style={{ display: "flex", flexDirection: "column", gap: "1rem" }}
						>
							{cardList.map((card) => {
								return (
									<MobileCardItem
										key={card.cardId}
										card={card}
										onPayStatement={(stmt) => {
											setSelectedCardId(card.cardId);
											setPayStatement(stmt);
										}}
									/>
								);
							})}
						</div>
					</div>

					{/* Desktop 3-Column OS View (Section 10) */}
					<div
						className="desktop-cards-os-layout"
						data-testid="desktop-cards-layout"
					>
						{/* LEFT: Card Selector */}
						<div
							className="cards-selector-column card"
							style={{
								padding: "1rem",
								display: "flex",
								flexDirection: "column",
								gap: "0.75rem",
							}}
							data-testid="cards-selector"
						>
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
									borderBottom: "1px solid var(--color-border, #e2e8f0)",
									paddingBottom: "0.5rem",
								}}
							>
								<span
									style={{
										fontWeight: 600,
										fontSize: "0.95rem",
										color: "var(--color-text-muted)",
									}}
								>
									Kartların ({cardList.length})
								</span>
							</div>

							<div
								className="card-selector-list"
								style={{
									display: "flex",
									flexDirection: "column",
									gap: "0.5rem",
								}}
							>
								{cardList.map((c) => {
									const isSelected = c.cardId === selectedCardId;
									return (
										<button
											key={c.cardId}
											type="button"
											className={`card-selector-item ${isSelected ? "selected" : ""}`}
											onClick={() => setSelectedCardId(c.cardId)}
											data-testid={`card-select-btn-${c.cardId}`}
											style={{
												textAlign: "left",
												padding: "0.75rem",
												borderRadius: "8px",
												border: isSelected
													? "2px solid var(--color-primary, #2563eb)"
													: "1px solid var(--color-border, #e2e8f0)",
												background: isSelected
													? "rgba(37, 99, 235, 0.05)"
													: "var(--color-bg-surface, #ffffff)",
												cursor: "pointer",
											}}
										>
											<div style={{ fontWeight: 600, fontSize: "0.95rem" }}>
												{c.displayName}
											</div>
											<div
												style={{
													fontSize: "0.8rem",
													color: "var(--color-text-muted, #64748b)",
													marginTop: "0.15rem",
												}}
											>
												{c.issuer}
												{c.lastFour ? ` •••• ${c.lastFour}` : ""}
											</div>
											<div
												style={{
													marginTop: "0.4rem",
													display: "flex",
													justifyContent: "space-between",
													fontSize: "0.85rem",
												}}
											>
												<span style={{ color: "var(--color-text-muted)" }}>
													Borç:
												</span>
												<strong
													style={{ color: "var(--color-text-main, #1e293b)" }}
													data-testid={`card-liability-${c.cardId}`}
												>
													{formatMoneyToTry(c.liveLiabilityBalance || "0.00")}
												</strong>
											</div>
										</button>
									);
								})}
							</div>
						</div>

						{/* CENTER: Selected Card Details & Statements */}
						{selectedCard && (
							<div
								className="selected-card-center-column"
								style={{
									display: "flex",
									flexDirection: "column",
									gap: "1.25rem",
								}}
								data-testid="selected-card-center"
							>
								{/* Card Hero Overview Card */}
								<div
									className="card selected-card-hero"
									style={{ padding: "1.25rem" }}
								>
									<div
										style={{
											display: "flex",
											justifyContent: "space-between",
											alignItems: "flex-start",
											marginBottom: "1rem",
										}}
									>
										<div>
											<h2 style={{ margin: 0, fontSize: "1.3rem" }}>
												{selectedCard.displayName}
											</h2>
											<div
												style={{
													fontSize: "0.85rem",
													color: "var(--color-text-muted, #64748b)",
													marginTop: "0.25rem",
												}}
											>
												{selectedCard.issuer}
												{selectedCard.lastFour
													? ` •••• ${selectedCard.lastFour}`
													: ""}{" "}
												• Kod: <code>{selectedCard.code}</code>
											</div>
										</div>

										<div style={{ display: "flex", gap: "0.5rem" }}>
											<Link
												to="/cards/$cardId/edit"
												params={{ cardId: selectedCard.cardId }}
												className="btn btn-secondary btn-sm"
												data-testid="edit-card-btn"
											>
												<Edit3 size={15} aria-hidden="true" />
												<span>Düzenle</span>
											</Link>
											<button
												type="button"
												className="btn btn-secondary btn-sm text-danger"
												onClick={() => setArchiveCard(selectedCard)}
												data-testid="archive-card-btn"
											>
												<Archive size={15} aria-hidden="true" />
												<span>Arşivle</span>
											</button>
										</div>
									</div>

									{/* Metrics Row */}
									<div
										style={{
											display: "grid",
											gridTemplateColumns:
												"repeat(auto-fit, minmax(140px, 1fr))",
											gap: "1rem",
											borderTop: "1px solid var(--color-border, #e2e8f0)",
											paddingTop: "0.75rem",
										}}
									>
										<div>
											<div
												style={{
													fontSize: "0.8rem",
													color: "var(--color-text-muted)",
												}}
											>
												Güncel Borç
											</div>
											<div
												style={{ fontSize: "1.3rem", fontWeight: 700 }}
												data-testid="selected-card-live-liability"
											>
												{formatMoneyToTry(
													selectedCard.liveLiabilityBalance || "0.00",
												)}
											</div>
										</div>

										<div>
											<div
												style={{
													fontSize: "0.8rem",
													color: "var(--color-text-muted)",
												}}
											>
												Kredi Limiti
											</div>
											<div
												style={{
													fontSize: "1.1rem",
													fontWeight: 600,
													color: "var(--color-text-muted, #64748b)",
												}}
											>
												{formatMoneyToTry(selectedCard.creditLimit)}
											</div>
										</div>

										<div>
											<div
												style={{
													fontSize: "0.8rem",
													color: "var(--color-text-muted)",
												}}
											>
												Kesim / Son Ödeme
											</div>
											<div style={{ fontSize: "0.95rem", fontWeight: 500 }}>
												Her ayın {selectedCard.statementDay}. /{" "}
												{selectedCard.dueDay}. günü
											</div>
										</div>
									</div>

									{/* Nearest OPEN Statement Hero Banner (Section 9) */}
									{nearestOpenStatement && (
										<div
											className="nearest-statement-banner"
											style={{
												marginTop: "1rem",
												padding: "0.85rem 1rem",
												borderRadius: "8px",
												background: "rgba(37, 99, 235, 0.08)",
												border: "1px solid rgba(37, 99, 235, 0.2)",
												display: "flex",
												justifyContent: "space-between",
												alignItems: "center",
											}}
											data-testid="nearest-statement-banner"
										>
											<div>
												<div
													style={{
														fontSize: "0.8rem",
														color: "#1e40af",
														fontWeight: 600,
													}}
												>
													En Yakın Açık Ekstre ({nearestOpenStatement.cycleYear}
													-
													{String(nearestOpenStatement.cycleMonth).padStart(
														2,
														"0",
													)}
													)
												</div>
												<div
													style={{ fontSize: "0.85rem", marginTop: "0.15rem" }}
												>
													Son Ödeme Tarihi:{" "}
													<strong>{nearestOpenStatement.dueDate}</strong> •
													Tutar:{" "}
													<strong>
														{formatMoneyToTry(
															nearestOpenStatement.statementAmount,
														)}
													</strong>
												</div>
												<div
													style={{
														fontSize: "0.8rem",
														color: "#64748b",
														marginTop: "0.15rem",
													}}
												>
													Kart Rezervi:{" "}
													<strong
														style={{
															color: nearestOpenStatement.reserveSatisfied
																? "#16a34a"
																: "#ca8a04",
														}}
													>
														{nearestOpenStatement.reserveSatisfied
															? "Hazır"
															: "Eksik"}
													</strong>
												</div>
											</div>

											<button
												type="button"
												className="btn btn-primary btn-sm"
												onClick={() => setPayStatement(nearestOpenStatement)}
												data-testid="nearest-pay-btn"
											>
												Öde
											</button>
										</div>
									)}
								</div>

								{/* Statements Component */}
								<div className="card" style={{ padding: "1.25rem" }}>
									<StatementList
										cardId={selectedCard.cardId}
										cardName={selectedCard.displayName}
										onNewStatement={() =>
											void navigate({
												to: "/cards/$cardId/statements/new",
												params: { cardId: selectedCard.cardId },
											})
										}
									/>
								</div>
							</div>
						)}

						{/* RIGHT: Recent Purchases */}
						{selectedCard && (
							<div
								className="card purchases-right-column"
								style={{ padding: "1.25rem" }}
								data-testid="purchases-right-column"
							>
								<PurchaseList
									cardId={selectedCard.cardId}
									cardName={selectedCard.displayName}
									onNewPurchase={() =>
										void navigate({
											to: "/cards/$cardId/purchases/new",
											params: { cardId: selectedCard.cardId },
										})
									}
								/>
							</div>
						)}
					</div>
				</>
			)}

			{/* Modals */}
			{archiveCard && (
				<CardArchiveModal
					isOpen={Boolean(archiveCard)}
					card={archiveCard}
					onClose={() => setArchiveCard(null)}
					onSuccess={() => {
						setArchiveCard(null);
						setSelectedCardId(null);
					}}
				/>
			)}

			{payStatement && selectedCard && (
				<StatementPayModal
					isOpen={Boolean(payStatement)}
					cardId={selectedCard.cardId}
					cardName={selectedCard.displayName}
					statement={payStatement}
					onClose={() => setPayStatement(null)}
				/>
			)}
		</div>
	);
}

/**
 * Mobile Card Item Component answering Section 9 requirements immediately:
 * - Hangi kartta ne kadar yükümlülük var?
 * - Ekstre ne zaman ödenecek?
 * - Kart Rezervi yeterli mi?
 */
function MobileCardItem({
	card,
	onPayStatement,
}: {
	card: CreditCardItem;
	onPayStatement: (stmt: CreditCardStatementItem) => void;
}) {
	const { data: stmtData } = useQuery({
		queryKey: ["card-statements", card.cardId, { status: "OPEN" }],
		queryFn: () =>
			fetchCreditCardStatements(card.cardId, { status: "OPEN", limit: 1 }),
	});

	const nearestOpenStmt = stmtData?.statements?.[0];

	return (
		<div
			className="card mobile-card-item"
			style={{ padding: "1rem" }}
			data-testid={`mobile-card-${card.cardId}`}
		>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "flex-start",
					marginBottom: "0.5rem",
				}}
			>
				<div>
					<Link
						to="/cards/$cardId"
						params={{ cardId: card.cardId }}
						style={{
							fontWeight: 600,
							fontSize: "1.1rem",
							color: "inherit",
							textDecoration: "none",
						}}
					>
						{card.displayName}
					</Link>
					<div
						style={{
							fontSize: "0.8rem",
							color: "var(--color-text-muted, #64748b)",
						}}
					>
						{card.issuer}
						{card.lastFour ? ` •••• ${card.lastFour}` : ""}
					</div>
				</div>

				<div style={{ textAlign: "right" }}>
					<div
						style={{ fontSize: "1.25rem", fontWeight: 700 }}
						data-testid={`mobile-liability-${card.cardId}`}
					>
						{formatMoneyToTry(card.liveLiabilityBalance || "0.00")}
					</div>
					<div
						style={{
							fontSize: "0.75rem",
							color: "var(--color-text-muted, #64748b)",
						}}
					>
						Kart Borcu
					</div>
				</div>
			</div>

			{nearestOpenStmt ? (
				<div
					style={{
						marginTop: "0.75rem",
						padding: "0.75rem",
						borderRadius: "6px",
						background: "rgba(37, 99, 235, 0.05)",
						border: "1px solid rgba(37, 99, 235, 0.15)",
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
					}}
				>
					<div>
						<div style={{ fontSize: "0.8rem" }}>
							Son Ödeme: <strong>{nearestOpenStmt.dueDate}</strong>
						</div>
						<div style={{ fontSize: "0.85rem", fontWeight: 600 }}>
							{formatMoneyToTry(nearestOpenStmt.statementAmount)}
						</div>
						<div style={{ fontSize: "0.75rem", color: "#64748b" }}>
							Rezerv:{" "}
							<span
								style={{
									color: nearestOpenStmt.reserveSatisfied
										? "#16a34a"
										: "#ca8a04",
									fontWeight: 600,
								}}
							>
								{nearestOpenStmt.reserveSatisfied ? "Hazır" : "Eksik"}
							</span>
						</div>
					</div>

					<button
						type="button"
						className="btn btn-primary btn-sm"
						onClick={() => onPayStatement(nearestOpenStmt)}
						data-testid={`mobile-pay-btn-${card.cardId}`}
					>
						Öde
					</button>
				</div>
			) : (
				<div
					style={{
						marginTop: "0.5rem",
						fontSize: "0.8rem",
						color: "var(--color-text-muted, #64748b)",
					}}
				>
					Açık ekstre bulunmuyor (Kesim: ayın {card.statementDay}. günü)
				</div>
			)}
		</div>
	);
}

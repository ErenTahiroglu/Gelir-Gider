import { useNavigate, useParams } from "@tanstack/react-router";
import "../../api/domain-errors";
import { CardDetailPage } from "./CardDetailPage";
import { CardForm } from "./CardForm";
import { PurchaseDetailPage } from "./purchases/PurchaseDetailPage";
import { PurchaseForm } from "./purchases/PurchaseForm";
import { SplitDetailPage } from "./purchases/SplitDetailPage";
import { StatementDetailPage } from "./statements/StatementDetailPage";
import { StatementForm } from "./statements/StatementForm";

export function CardDetailPageWrapper() {
	const { cardId } = useParams({ strict: false }) as { cardId: string };
	return <CardDetailPage cardId={cardId} />;
}

export function CardNewPage() {
	const navigate = useNavigate();
	return (
		<div className="form-page-container">
			<div className="form-page-card card">
				<h1 className="page-title">Yeni Kredi Kartı</h1>
				<CardForm
					mode="create"
					onSuccess={(c) =>
						void navigate({
							to: "/cards/$cardId",
							params: { cardId: c.cardId },
						})
					}
					onCancel={() => void navigate({ to: "/cards" })}
				/>
			</div>
		</div>
	);
}

export function CardEditPage() {
	const { cardId } = useParams({ strict: false }) as { cardId: string };
	const navigate = useNavigate();
	return (
		<div className="form-page-container">
			<div className="form-page-card card">
				<h1 className="page-title">Kartı Düzenle</h1>
				<CardForm
					mode="edit"
					cardId={cardId}
					onSuccess={() =>
						void navigate({
							to: "/cards/$cardId",
							params: { cardId },
						})
					}
					onCancel={() =>
						void navigate({
							to: "/cards/$cardId",
							params: { cardId },
						})
					}
				/>
			</div>
		</div>
	);
}

export function StatementNewPage() {
	const { cardId } = useParams({ strict: false }) as { cardId: string };
	const navigate = useNavigate();
	return (
		<div className="form-page-container">
			<div className="form-page-card card">
				<h1 className="page-title">Yeni Ekstre</h1>
				<StatementForm
					mode="create"
					cardId={cardId}
					onSuccess={(s) =>
						void navigate({
							to: "/cards/$cardId/statements/$statementId",
							params: { cardId, statementId: s.statementId },
						})
					}
					onCancel={() =>
						void navigate({
							to: "/cards/$cardId",
							params: { cardId },
						})
					}
				/>
			</div>
		</div>
	);
}

export function StatementDetailPageWrapper() {
	const { cardId, statementId } = useParams({ strict: false }) as {
		cardId: string;
		statementId: string;
	};
	return <StatementDetailPage cardId={cardId} statementId={statementId} />;
}

export function PurchaseNewPage() {
	const { cardId } = useParams({ strict: false }) as { cardId: string };
	const navigate = useNavigate();
	return (
		<div className="form-page-container">
			<div className="form-page-card card">
				<h1 className="page-title">Yeni Kart Harcaması</h1>
				<PurchaseForm
					cardId={cardId}
					onSuccess={() =>
						void navigate({
							to: "/cards/$cardId",
							params: { cardId },
						})
					}
					onCancel={() =>
						void navigate({
							to: "/cards/$cardId",
							params: { cardId },
						})
					}
				/>
			</div>
		</div>
	);
}

export function PurchaseDetailPageWrapper() {
	const { cardId, purchaseId } = useParams({ strict: false }) as {
		cardId: string;
		purchaseId: string;
	};
	return <PurchaseDetailPage cardId={cardId} purchaseId={purchaseId} />;
}

export function SplitDetailPageWrapper() {
	const { cardId, purchaseId } = useParams({ strict: false }) as {
		cardId: string;
		purchaseId: string;
	};
	return <SplitDetailPage cardId={cardId} purchaseId={purchaseId} />;
}

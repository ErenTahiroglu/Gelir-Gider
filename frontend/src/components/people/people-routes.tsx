import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import "../../api/domain-errors";
import type { PersonObligationDirection } from "../../api/people-types";
import { ObligationDetailPage } from "./obligations/ObligationDetailPage";
import { ObligationForm } from "./obligations/ObligationForm";
import { PersonDetailPage } from "./PersonDetailPage";
import { PersonForm } from "./PersonForm";
import { PersonSettleReceivablesPage } from "./settlements/PersonSettleReceivablesPage";

export function PersonDetailPageWrapper() {
	const { personId } = useParams({ strict: false }) as { personId: string };
	return <PersonDetailPage personId={personId} />;
}

export function PersonNewPage() {
	const navigate = useNavigate();
	return (
		<div className="form-page-container">
			<div className="form-page-card card">
				<h1 className="page-title">Yeni Kişi Ekle</h1>
				<PersonForm
					mode="create"
					onSuccess={(p) =>
						void navigate({
							to: "/people/$personId",
							params: { personId: p.personId },
						})
					}
					onCancel={() => void navigate({ to: "/people" })}
				/>
			</div>
		</div>
	);
}

export function PersonEditPage() {
	const { personId } = useParams({ strict: false }) as { personId: string };
	const navigate = useNavigate();
	return (
		<div className="form-page-container">
			<div className="form-page-card card">
				<h1 className="page-title">Kişiyi Düzenle</h1>
				<PersonForm
					mode="edit"
					personId={personId}
					onSuccess={() =>
						void navigate({
							to: "/people/$personId",
							params: { personId },
						})
					}
					onCancel={() =>
						void navigate({
							to: "/people/$personId",
							params: { personId },
						})
					}
				/>
			</div>
		</div>
	);
}

export function ObligationNewPage() {
	const { personId } = useParams({ strict: false }) as { personId: string };
	const search = useSearch({ strict: false }) as {
		direction?: PersonObligationDirection;
	};
	const navigate = useNavigate();
	return (
		<div className="form-page-container">
			<div className="form-page-card card">
				<h1 className="page-title">
					{search?.direction === "PAYABLE"
						? "Yeni Borçlanma Kaydı"
						: "Yeni Borç Verme Kaydı"}
				</h1>
				<ObligationForm
					mode="create"
					personId={personId}
					initialDirection={search?.direction ?? "RECEIVABLE"}
					onSuccess={(ob) =>
						void navigate({
							to: "/people/$personId/obligations/$obligationId",
							params: {
								personId,
								obligationId: ob.obligationId,
							},
						})
					}
					onCancel={() =>
						void navigate({
							to: "/people/$personId",
							params: { personId },
						})
					}
				/>
			</div>
		</div>
	);
}

export function ObligationDetailPageWrapper() {
	const { personId, obligationId } = useParams({ strict: false }) as {
		personId: string;
		obligationId: string;
	};
	return (
		<ObligationDetailPage personId={personId} obligationId={obligationId} />
	);
}

export function PersonSettlePageWrapper() {
	const { personId } = useParams({ strict: false }) as { personId: string };
	return <PersonSettleReceivablesPage personId={personId} />;
}

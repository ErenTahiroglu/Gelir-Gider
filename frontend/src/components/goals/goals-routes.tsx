import { useNavigate, useParams } from "@tanstack/react-router";
import "../../api/domain-errors";
import { GoalDetailPage } from "./GoalDetailPage";
import { GoalForm } from "./GoalForm";

export function GoalDetailPageWrapper() {
	const { goalId } = useParams({ strict: false }) as { goalId: string };
	return <GoalDetailPage goalId={goalId} />;
}

export function GoalNewPage() {
	const navigate = useNavigate();
	return (
		<div className="form-page-container">
			<div className="form-page-card card">
				<h1 className="page-title">Yeni Hedef Ekle</h1>
				<GoalForm
					mode="create"
					onSuccess={(g) =>
						void navigate({
							to: "/goals/$goalId",
							params: { goalId: g.goalId },
						})
					}
					onCancel={() => void navigate({ to: "/goals" })}
				/>
			</div>
		</div>
	);
}

export function GoalEditPage() {
	const { goalId } = useParams({ strict: false }) as { goalId: string };
	const navigate = useNavigate();
	return (
		<div className="form-page-container">
			<div className="form-page-card card">
				<h1 className="page-title">Hedefi Düzenle</h1>
				<GoalForm
					mode="edit"
					goalId={goalId}
					onSuccess={() =>
						void navigate({
							to: "/goals/$goalId",
							params: { goalId },
						})
					}
					onCancel={() =>
						void navigate({
							to: "/goals/$goalId",
							params: { goalId },
						})
					}
				/>
			</div>
		</div>
	);
}

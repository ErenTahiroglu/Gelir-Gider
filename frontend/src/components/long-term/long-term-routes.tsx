import { useParams } from "@tanstack/react-router";
import "../../api/domain-errors";
import { LongTermTaskDetailPage } from "./LongTermTaskDetailPage";
import { LongTermTaskForm } from "./LongTermTaskForm";

export function LongTermTaskDetailPageWrapper() {
	const { taskId } = useParams({ strict: false }) as { taskId: string };
	return <LongTermTaskDetailPage taskId={taskId} />;
}

export function LongTermNewPage() {
	return (
		<div className="form-page-container">
			<LongTermTaskForm />
		</div>
	);
}

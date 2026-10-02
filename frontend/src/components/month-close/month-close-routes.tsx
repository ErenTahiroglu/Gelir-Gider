import { useParams } from "@tanstack/react-router";
import "../../api/domain-errors";
import { MonthCloseDetailPage } from "./MonthCloseDetailPage";
import { MonthCloseWizard } from "./MonthCloseWizard";

export function MonthCloseWizardPage() {
	return (
		<div className="form-page-container">
			<MonthCloseWizard />
		</div>
	);
}

export function MonthCloseDetailPageWrapper() {
	const { periodMonth } = useParams({ strict: false }) as {
		periodMonth: string;
	};
	return <MonthCloseDetailPage periodMonth={periodMonth} />;
}

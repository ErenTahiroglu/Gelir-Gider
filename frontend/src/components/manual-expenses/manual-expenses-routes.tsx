import { useParams } from "@tanstack/react-router";
import { ManualExpenseForm } from "./ManualExpenseForm";

export function ManualExpenseNewPage() {
	return (
		<div className="form-page-container">
			<div className="form-page-card card">
				<h1 className="page-title">Yeni Nakit / Banka Harcaması</h1>
				<ManualExpenseForm mode="create" />
			</div>
		</div>
	);
}

export function ManualExpenseEditPage() {
	const { expenseId } = useParams({ strict: false }) as { expenseId: string };
	return (
		<div className="form-page-container">
			<div className="form-page-card card">
				<h1 className="page-title">Harcamayı Düzenle</h1>
				<ManualExpenseForm mode="edit" expenseId={expenseId} />
			</div>
		</div>
	);
}

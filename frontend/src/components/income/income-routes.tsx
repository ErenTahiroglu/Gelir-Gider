import { useParams } from "@tanstack/react-router";
import { EntitlementDetail } from "./EntitlementDetail";
import { EntitlementForm } from "./EntitlementForm";
import { IncomeReceiptDetail } from "./IncomeReceiptDetail";
import { IncomeReceiptForm } from "./IncomeReceiptForm";
import { IncomeSourceForm } from "./IncomeSourceForm";

export function IncomeSourceNewPage() {
	return <IncomeSourceForm />;
}

export function EntitlementNewPage() {
	return (
		<div className="form-page-container">
			<div className="form-page-card card">
				<h1 className="page-title">Yeni Beklenen Gelir</h1>
				<EntitlementForm />
			</div>
		</div>
	);
}

export function EntitlementDetailPageWrapper() {
	const { entitlementId } = useParams({ strict: false }) as {
		entitlementId: string;
	};
	return <EntitlementDetail entitlementId={entitlementId} />;
}

export function IncomeReceiptNewPage() {
	return (
		<div className="form-page-container">
			<div className="form-page-card card">
				<h1 className="page-title">Yeni Gelir Tahsilatı</h1>
				<IncomeReceiptForm />
			</div>
		</div>
	);
}

export function IncomeReceiptDetailPageWrapper() {
	const { incomeReceiptId } = useParams({ strict: false }) as {
		incomeReceiptId: string;
	};
	return <IncomeReceiptDetail incomeReceiptId={incomeReceiptId} />;
}

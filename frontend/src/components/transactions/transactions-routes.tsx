import { useParams } from "@tanstack/react-router";
import { TransactionTimeline } from "./TransactionTimeline";

export function TransactionsListPage() {
	return <TransactionTimeline />;
}

export function TransactionDetailPage() {
	const { transactionId } = useParams({ strict: false }) as {
		transactionId?: string;
	};
	return <TransactionTimeline initialTransactionId={transactionId ?? null} />;
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { ApiError } from "../../../api/errors";
import { fetchAllLedgerAccounts } from "../../../api/manual-expenses-api";
import { settlePersonPayable } from "../../../api/people-api";
import type { ObligationProductDto } from "../../../api/people-types";
import {
	formatCentsToTry,
	formatMoneyToTry,
	normalizeTurkishMoneyInput,
	parseMoneyToCents,
} from "../../../lib/money";
import { AccessibleModal } from "../../common/AccessibleModal";
import { MoneyInput } from "../../common/MoneyInput";

interface PayableSettlementModalProps {
	isOpen: boolean;
	onClose: () => void;
	personId: string;
	obligation: ObligationProductDto;
	onSuccess?: (() => void) | undefined;
}

export function PayableSettlementModal({
	isOpen,
	onClose,
	personId,
	obligation,
	onSuccess,
}: PayableSettlementModalProps) {
	const queryClient = useQueryClient();

	const remainingCents = parseMoneyToCents(obligation.remainingAmount);

	const [amount, setAmount] = useState(obligation.remainingAmount);
	const [sourceAssetAccountId, setSourceAssetAccountId] = useState("");
	const [note, setNote] = useState("");
	const [error, setError] = useState<string | null>(null);

	const currentKeyRef = useRef<string>(crypto.randomUUID());

	// Fetch user's eligible ledger accounts
	const { data: accounts, isLoading: accountsLoading } = useQuery({
		queryKey: ["ledger-accounts"],
		queryFn: () => fetchAllLedgerAccounts(100),
		staleTime: 60_000,
	});

	const selectableAccounts = useMemo(
		() =>
			(accounts ?? []).filter(
				(acc) =>
					acc.accountType === "ASSET" &&
					acc.currency === "TRY" &&
					acc.archived === false,
			),
		[accounts],
	);

	// Select first account by default if not selected
	const activeAccountId =
		sourceAssetAccountId || (selectableAccounts[0]?.accountId ?? "");

	const mutation = useMutation({
		mutationFn: async () => {
			const norm = normalizeTurkishMoneyInput(amount);
			if (!norm.valid || !norm.canonical || norm.cents === undefined) {
				throw new Error(norm.error ?? "Geçerli bir ödeme tutarı girin.");
			}

			if (norm.cents <= 0n) {
				throw new Error("Ödeme tutarı sıfırdan büyük olmalıdır.");
			}

			// BigInt oversettlement guard (Section 51)
			if (norm.cents > remainingCents) {
				throw new Error(
					`Ödeme tutarı kalan borç tutarından (${formatCentsToTry(remainingCents)}) fazla olamaz.`,
				);
			}

			if (!activeAccountId) {
				throw new Error("Lütfen ödemenin yapılacağı hesabı seçin.");
			}

			return settlePersonPayable(
				personId,
				obligation.obligationId,
				{
					amount: norm.canonical,
					sourceAssetAccountId: activeAccountId,
					note: note.trim() !== "" ? note.trim() : undefined,
					occurredAt: new Date().toISOString(),
				},
				currentKeyRef.current,
			);
		},
		retry: false,
		onSuccess: () => {
			// Query invalidation per Section 57
			void queryClient.invalidateQueries({ queryKey: ["people"] });
			void queryClient.invalidateQueries({ queryKey: ["active-people"] });
			void queryClient.invalidateQueries({ queryKey: ["person", personId] });
			void queryClient.invalidateQueries({
				queryKey: ["person-balance-summary", personId],
			});
			void queryClient.invalidateQueries({
				queryKey: ["person-obligations", personId],
			});
			void queryClient.invalidateQueries({
				queryKey: ["person-obligation", personId, obligation.obligationId],
			});
			void queryClient.invalidateQueries({ queryKey: ["person-settlements"] });
			void queryClient.invalidateQueries({ queryKey: ["transactions"] });
			void queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] });
			void queryClient.invalidateQueries({ queryKey: ["midas-liquidity"] });
			void queryClient.invalidateQueries({
				queryKey: ["active-credit-cards"],
			});
			void queryClient.invalidateQueries({ queryKey: ["card-statements"] });
			void queryClient.invalidateQueries({ queryKey: ["spending-summary"] });

			currentKeyRef.current = crypto.randomUUID();
			onClose();
			onSuccess?.();
		},
		onError: (err) => {
			if (err instanceof ApiError) {
				setError(err.userMessage);
			} else if (err instanceof Error) {
				setError(err.message);
			} else {
				setError("Ödeme kaydedilirken bir hata oluştu.");
			}
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		mutation.mutate();
	};

	return (
		<AccessibleModal
			isOpen={isOpen}
			onClose={onClose}
			title="Borcu Öde"
			className="payable-settlement-modal"
		>
			<form
				onSubmit={handleSubmit}
				className="payable-settlement-form"
				data-testid="payable-settlement-form"
			>
				{error && (
					<div
						className="alert alert-danger"
						role="alert"
						data-testid="settle-payable-error"
					>
						<AlertCircle size={18} aria-hidden="true" />
						<span>{error}</span>
					</div>
				)}

				<div className="settlement-info-card">
					<div className="info-row">
						<span className="info-label">Toplam Borç:</span>
						<span className="info-value">
							{formatMoneyToTry(obligation.principalAmount)}
						</span>
					</div>
					<div className="info-row">
						<span className="info-label">Kalan Borç Tutarı:</span>
						<span className="info-value highlight-payable">
							{formatCentsToTry(remainingCents)}
						</span>
					</div>
				</div>

				<div className="form-group">
					<label htmlFor="payable-amount" className="form-label">
						Ödenecek Tutar <span className="required-star">*</span>
					</label>
					<MoneyInput
						id="payable-amount"
						value={amount}
						onChange={(val) => setAmount(val)}
						disabled={mutation.isPending}
						data-testid="payable-amount-input"
						required
					/>
					<span className="form-hint">
						Maksimum ödenebilecek tutar: {formatCentsToTry(remainingCents)}
					</span>
				</div>

				<div className="form-group">
					<label htmlFor="payable-source-account" className="form-label">
						Ödemenin Yapıldığı Hesap <span className="required-star">*</span>
					</label>
					{accountsLoading ? (
						<p className="text-secondary">Hesaplar yükleniyor...</p>
					) : (
						<select
							id="payable-source-account"
							className="form-control"
							value={activeAccountId}
							onChange={(e) => setSourceAssetAccountId(e.target.value)}
							disabled={mutation.isPending}
							data-testid="payable-source-account-select"
							required
						>
							{selectableAccounts.map((acc) => (
								<option key={acc.accountId} value={acc.accountId}>
									{acc.name} ({formatMoneyToTry(acc.balance)})
								</option>
							))}
						</select>
					)}
				</div>

				<div className="form-group">
					<label htmlFor="payable-note" className="form-label">
						Not (İsteğe Bağlı)
					</label>
					<input
						id="payable-note"
						type="text"
						className="form-control"
						value={note}
						onChange={(e) => setNote(e.target.value)}
						maxLength={500}
						placeholder="Örn: Havale ile ödendi"
						disabled={mutation.isPending}
						data-testid="payable-note-input"
					/>
				</div>

				<div className="modal-actions">
					<button
						type="button"
						className="btn btn-secondary"
						onClick={onClose}
						disabled={mutation.isPending}
					>
						Vazgeç
					</button>
					<button
						type="submit"
						className="btn btn-primary"
						disabled={mutation.isPending}
						data-testid="confirm-settle-payable-btn"
					>
						<CheckCircle2 size={16} aria-hidden="true" />
						<span>
							{mutation.isPending ? "Kaydediliyor..." : "Ödemeyi Kaydet"}
						</span>
					</button>
				</div>
			</form>
		</AccessibleModal>
	);
}

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Plus } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { ApiError, isNetworkUncertainError } from "../../api/errors";
import {
	createIncomeReceipt,
	fetchAllActiveIncomeSources,
} from "../../api/income-api";
import type {
	CreateIncomeReceiptPayload,
	ProductLedgerAccountItem,
} from "../../api/income-types";
import { fetchAllLedgerAccounts } from "../../api/manual-expenses-api";
import {
	formatIstanbulDateTimeLocal,
	parseIstanbulDateTimeLocalToIso,
} from "../../lib/istanbul-date";
import { MoneyInput } from "../common/MoneyInput";
import { LedgerAccountProvisionModal } from "./LedgerAccountProvisionModal";

interface IncomeReceiptFormProps {
	initialValues?: {
		sourceId?: string;
		amount?: string;
		note?: string;
	};
	onSuccess?: () => void;
	onCancel?: () => void;
	isQuickEntry?: boolean;
}

export function IncomeReceiptForm({
	initialValues,
	onSuccess,
	onCancel,
	isQuickEntry = false,
}: IncomeReceiptFormProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const defaultDateTimeLocal = formatIstanbulDateTimeLocal(new Date());

	// Form fields
	const [sourceId, setSourceId] = useState(initialValues?.sourceId ?? "");
	const [amount, setAmount] = useState(initialValues?.amount ?? "");
	const [destinationAccountId, setDestinationAccountId] = useState("");
	const [receivedAtLocal, setReceivedAtLocal] = useState(defaultDateTimeLocal);
	const [note, setNote] = useState(initialValues?.note ?? "");

	// State for inline modal and submission
	const [isAssetModalOpen, setIsAssetModalOpen] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [uncertainWarning, setUncertainWarning] = useState<string | null>(null);

	const frozenAttemptRef = useRef<{
		key: string;
		payload: CreateIncomeReceiptPayload;
	} | null>(null);

	// Load active sources
	const { data: sources, isLoading: sourcesLoading } = useQuery({
		queryKey: ["income-sources", { activeOnly: true }],
		queryFn: () => fetchAllActiveIncomeSources(100),
		staleTime: 60_000,
	});

	// Load all accounts
	const { data: accounts, isLoading: accountsLoading } = useQuery({
		queryKey: ["ledger-accounts"],
		queryFn: () => fetchAllLedgerAccounts(100),
		staleTime: 60_000,
	});

	const eligibleSources = useMemo(
		() => (sources ?? []).filter((s) => !s.archivedAt),
		[sources],
	);

	// Eligible destination: ASSET, DEBIT, TRY, !archived
	const eligibleAssetAccounts = useMemo(() => {
		return (accounts ?? []).filter(
			(acc) =>
				acc.accountType === "ASSET" &&
				acc.normalBalance === "DEBIT" &&
				acc.currency === "TRY" &&
				!acc.archived,
		);
	}, [accounts]);

	const handleAccountCreated = (account: ProductLedgerAccountItem) => {
		setDestinationAccountId(account.accountId);
	};

	const executeSubmit = async (isRetry: boolean) => {
		setFormError(null);
		setUncertainWarning(null);

		if (!sourceId) {
			setFormError("Lütfen bir gelir kaynağı seçin.");
			return;
		}

		if (!amount || Number.parseFloat(amount) <= 0) {
			setFormError("Lütfen sıfırdan büyük geçerli bir tahsilat tutarı girin.");
			return;
		}

		if (!destinationAccountId) {
			setFormError("Lütfen paranın yattığı kasa/banka hesabını seçin.");
			return;
		}

		let canonicalReceivedAtIso: string;
		try {
			canonicalReceivedAtIso = parseIstanbulDateTimeLocalToIso(receivedAtLocal);
		} catch {
			setFormError("Geçerli bir tahsilat tarihi ve saati girin.");
			return;
		}

		let key: string;
		let payload: CreateIncomeReceiptPayload;

		if (isRetry && frozenAttemptRef.current) {
			key = frozenAttemptRef.current.key;
			payload = frozenAttemptRef.current.payload;
		} else {
			key = crypto.randomUUID();
			payload = {
				sourceId,
				receivedAt: canonicalReceivedAtIso,
				amount,
				destinationAccountId,
				note: note.trim() ? note.trim() : null,
			};
			frozenAttemptRef.current = { key, payload };
		}

		setSubmitting(true);
		try {
			const res = await createIncomeReceipt(payload, key);
			await queryClient.invalidateQueries({ queryKey: ["income-receipts"] });
			await queryClient.invalidateQueries({ queryKey: ["income-reference"] });
			await queryClient.invalidateQueries({ queryKey: ["transactions"] });
			await queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] });

			if (onSuccess) {
				onSuccess();
			} else {
				void navigate({
					to: "/income/receipts/$incomeReceiptId",
					params: { incomeReceiptId: res.incomeReceiptId },
				});
			}
		} catch (err) {
			if (isNetworkUncertainError(err)) {
				setUncertainWarning(
					"Ağ bağlantısı belirsiz. Tahsilat sunucuya ulaşmış olabilir. Lütfen 'Aynı Bilgilerle Tekrar Dene' ile yeniden gönderin.",
				);
			} else if (err instanceof ApiError) {
				setFormError(err.userMessage);
			} else {
				setFormError(
					"Gelir tahsilatı kaydedilirken beklenmeyen bir hata oluştu.",
				);
			}
		} finally {
			setSubmitting(false);
		}
	};

	const formContent = (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				void executeSubmit(false);
			}}
			className="income-receipt-form"
		>
			{formError && (
				<div className="alert alert-danger mb-4" role="alert">
					{formError}
				</div>
			)}

			{uncertainWarning && (
				<div className="alert alert-warning mb-4" role="alert">
					{uncertainWarning}
				</div>
			)}

			<div className="form-group mb-3">
				<label htmlFor="receipt-source" className="form-label">
					Gelir Kaynağı
				</label>
				{sourcesLoading ? (
					<p className="text-sm text-secondary">Kaynaklar yükleniyor...</p>
				) : (
					<select
						id="receipt-source"
						className="form-control"
						value={sourceId}
						onChange={(e) => setSourceId(e.target.value)}
						required
					>
						<option value="">Kaynak Seçin...</option>
						{eligibleSources.map((s) => (
							<option key={s.sourceId} value={s.sourceId}>
								{s.name} ({s.code})
							</option>
						))}
					</select>
				)}
			</div>

			<div className="form-group mb-3">
				<label htmlFor="receipt-amount" className="form-label">
					Tahsil Edilen Tutar
				</label>
				<MoneyInput
					id="receipt-amount"
					value={amount}
					onChange={setAmount}
					placeholder="0,00"
					required
				/>
			</div>

			<div className="form-group mb-3">
				<div className="flex justify-between items-center mb-1">
					<label
						htmlFor="receipt-destination-account"
						className="form-label mb-0"
					>
						Yatan Hesap (Kasa / Banka)
					</label>
					<button
						type="button"
						className="btn btn-sm btn-outline-primary flex items-center gap-1"
						onClick={() => setIsAssetModalOpen(true)}
					>
						<Plus size={14} aria-hidden="true" />
						<span>Hesap Oluştur</span>
					</button>
				</div>
				{accountsLoading ? (
					<p className="text-sm text-secondary">Hesaplar yükleniyor...</p>
				) : (
					<select
						id="receipt-destination-account"
						className="form-control"
						value={destinationAccountId}
						onChange={(e) => setDestinationAccountId(e.target.value)}
						required
					>
						<option value="">Hesap Seçin...</option>
						{eligibleAssetAccounts.map((acc) => (
							<option key={acc.accountId} value={acc.accountId}>
								{acc.name} ({acc.code})
							</option>
						))}
					</select>
				)}
			</div>

			<div className="form-group mb-3">
				<label htmlFor="receipt-datetime" className="form-label">
					Tahsilat Zamanı (Türkiye Saati)
				</label>
				<input
					id="receipt-datetime"
					type="datetime-local"
					className="form-control"
					value={receivedAtLocal}
					onChange={(e) => setReceivedAtLocal(e.target.value)}
					required
				/>
			</div>

			<div className="form-group mb-4">
				<label htmlFor="receipt-note" className="form-label">
					Not / Açıklama (İsteğe Bağlı)
				</label>
				<input
					id="receipt-note"
					type="text"
					className="form-control"
					value={note}
					onChange={(e) => setNote(e.target.value)}
					placeholder="Örn: Eylül ayı maaş ödemesi"
					maxLength={255}
				/>
			</div>

			<div className="form-actions flex justify-end gap-2 mt-6">
				<button
					type="button"
					className="btn btn-secondary"
					onClick={() => {
						if (onCancel) onCancel();
						else void navigate({ to: "/income" });
					}}
					disabled={submitting}
				>
					İptal
				</button>

				{uncertainWarning && (
					<button
						type="button"
						className="btn btn-warning"
						onClick={() => void executeSubmit(true)}
						disabled={submitting}
					>
						Aynı Bilgilerle Tekrar Dene
					</button>
				)}

				<button
					type="submit"
					className="btn btn-primary"
					disabled={submitting || !sourceId || !amount || !destinationAccountId}
					data-testid="btn-submit-receipt"
				>
					{submitting ? "Kaydediliyor..." : "Geliri Kaydet"}
				</button>
			</div>

			<LedgerAccountProvisionModal
				isOpen={isAssetModalOpen}
				accountType="ASSET"
				onClose={() => setIsAssetModalOpen(false)}
				onAccountCreated={handleAccountCreated}
			/>
		</form>
	);

	if (isQuickEntry) {
		return formContent;
	}

	return (
		<div className="form-page-container">
			<div className="form-page-card card">
				<div className="flex items-center gap-3 mb-4">
					<button
						type="button"
						className="btn btn-icon btn-secondary"
						onClick={() => void navigate({ to: "/income" })}
						aria-label="Geri Dön"
					>
						<ArrowLeft size={18} aria-hidden="true" />
					</button>
					<h1 className="page-title">Gerçekleşen Gelir Girişi</h1>
				</div>

				{formContent}
			</div>
		</div>
	);
}

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Info } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { ApiError, isNetworkUncertainError } from "../../api/errors";
import {
	createIncomeEntitlement,
	fetchAllActiveIncomeSources,
} from "../../api/income-api";
import type { CreateIncomeEntitlementPayload } from "../../api/income-types";
import {
	getIstanbulCalendarDate,
	toEntitlementPeriodMonth,
} from "../../lib/istanbul-date";
import { parseMoneyToCents } from "../../lib/money";
import { MoneyInput } from "../common/MoneyInput";

export function EntitlementForm() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const currentIstanbul = getIstanbulCalendarDate();
	const defaultPeriodMonthUi = currentIstanbul.periodMonth; // "YYYY-MM"

	// Form fields
	const [sourceId, setSourceId] = useState("");
	const [periodMonthUi, setPeriodMonthUi] = useState(defaultPeriodMonthUi);
	const [amount, setAmount] = useState("");
	const [expectedReceiptOn, setExpectedReceiptOn] = useState("");
	const [note, setNote] = useState("");

	// Submission & retry states
	const [submitting, setSubmitting] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [uncertainWarning, setUncertainWarning] = useState<string | null>(null);

	const frozenAttemptRef = useRef<{
		key: string;
		payload: CreateIncomeEntitlementPayload;
	} | null>(null);

	// Load active income sources
	const { data: sources, isLoading: sourcesLoading } = useQuery({
		queryKey: ["income-sources", { activeOnly: true }],
		queryFn: () => fetchAllActiveIncomeSources(100),
		staleTime: 60_000,
	});

	// Only REGULAR active sources are eligible for entitlements
	const eligibleSources = useMemo(() => {
		return (sources ?? []).filter(
			(s) => s.nature === "REGULAR" && !s.archivedAt,
		);
	}, [sources]);

	// Auto-fill amount from source if source has expectedMonthlyAmount and amount is empty
	const handleSourceSelect = (selectedId: string) => {
		setSourceId(selectedId);
		const found = eligibleSources.find((s) => s.sourceId === selectedId);
		if (found?.expectedMonthlyAmount && !amount) {
			setAmount(found.expectedMonthlyAmount);
		}
	};

	const executeSubmit = async (isRetry: boolean) => {
		setFormError(null);
		setUncertainWarning(null);

		if (!sourceId) {
			setFormError("Lütfen bir gelir kaynağı seçin.");
			return;
		}

		let amountCents: bigint;
		try {
			amountCents = parseMoneyToCents(amount);
		} catch {
			setFormError("Geçerli bir tutar girin.");
			return;
		}

		if (amountCents <= 0n) {
			setFormError("Lütfen sıfırdan büyük geçerli bir beklenen tutar girin.");
			return;
		}

		let periodMonthApi: string;
		try {
			periodMonthApi = toEntitlementPeriodMonth(periodMonthUi); // "YYYY-MM-01"
		} catch {
			setFormError("Geçerli bir dönem ayı seçin.");
			return;
		}

		let key: string;
		let payload: CreateIncomeEntitlementPayload;

		if (isRetry && frozenAttemptRef.current) {
			key = frozenAttemptRef.current.key;
			payload = frozenAttemptRef.current.payload;
		} else {
			key = crypto.randomUUID();
			payload = {
				sourceId,
				periodMonth: periodMonthApi,
				amount,
				expectedReceiptOn: expectedReceiptOn ? expectedReceiptOn : null,
				note: note.trim() ? note.trim() : null,
			};
			frozenAttemptRef.current = { key, payload };
		}

		setSubmitting(true);
		try {
			const res = await createIncomeEntitlement(payload, key);
			await queryClient.invalidateQueries({
				queryKey: ["income-entitlements"],
			});
			void navigate({
				to: "/income/entitlements/$entitlementId",
				params: { entitlementId: res.entitlementId },
			});
		} catch (err) {
			if (isNetworkUncertainError(err)) {
				setUncertainWarning(
					"Ağ bağlantısı belirsiz. İstek sunucuya ulaşmış olabilir. Lütfen 'Aynı Bilgilerle Tekrar Dene' ile yeniden gönderin.",
				);
			} else if (err instanceof ApiError) {
				setFormError(err.userMessage);
			} else {
				setFormError(
					"Beklenen gelir kaydedilirken beklenmeyen bir hata oluştu.",
				);
			}
		} finally {
			setSubmitting(false);
		}
	};

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
					<h1 className="page-title">Yeni Beklenen Gelir</h1>
				</div>

				<div
					className="alert alert-info flex items-start gap-2 mb-4"
					role="note"
				>
					<Info size={18} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
					<div className="text-sm">
						<strong>Tahakkuk Bilgisi:</strong> Beklenen gelir, belirli bir ayda
						almayı öngördüğünüz tutardır. Bir bütçe beklentisidir ve hesabınıza
						henüz para girmediğini ifade eder. Kasa veya banka bakiyesini
						artırmaz.
					</div>
				</div>

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

				<form
					onSubmit={(e) => {
						e.preventDefault();
						void executeSubmit(false);
					}}
					className="entitlement-form"
				>
					<div className="form-group mb-3">
						<label htmlFor="entitlement-source" className="form-label">
							Düzenli Gelir Kaynağı
						</label>
						{sourcesLoading ? (
							<p className="text-sm text-secondary">Kaynaklar yükleniyor...</p>
						) : (
							<select
								id="entitlement-source"
								className="form-control"
								value={sourceId}
								onChange={(e) => handleSourceSelect(e.target.value)}
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
						{eligibleSources.length === 0 && !sourcesLoading && (
							<small className="form-text text-warning">
								Beklenen gelir yalnızca "Düzenli Gelir" niteliğindeki aktif
								kaynaklar için oluşturulabilir.
							</small>
						)}
					</div>

					<div className="form-group mb-3">
						<label htmlFor="entitlement-period" className="form-label">
							Dönem Ayı (YYYY-MM)
						</label>
						<input
							id="entitlement-period"
							type="month"
							className="form-control"
							value={periodMonthUi}
							onChange={(e) => setPeriodMonthUi(e.target.value)}
							required
						/>
						<small className="form-text text-secondary">
							Hangi ay için gelir bekleniyor (sunucuya YYYY-MM-01 formatında
							iletilir).
						</small>
					</div>

					<div className="form-group mb-3">
						<label htmlFor="entitlement-amount" className="form-label">
							Beklenen Tutar
						</label>
						<MoneyInput
							id="entitlement-amount"
							value={amount}
							onChange={setAmount}
							placeholder="0,00"
							required
						/>
					</div>

					<div className="form-group mb-3">
						<label htmlFor="entitlement-expected-on" className="form-label">
							Tahmini Tahsilat Günü (İsteğe Bağlı)
						</label>
						<input
							id="entitlement-expected-on"
							type="date"
							className="form-control"
							value={expectedReceiptOn}
							onChange={(e) => setExpectedReceiptOn(e.target.value)}
						/>
						<small className="form-text text-secondary">
							Gelirin hesaba geçmesini beklediğiniz takvim günü.
						</small>
					</div>

					<div className="form-group mb-4">
						<label htmlFor="entitlement-note" className="form-label">
							Not / Açıklama (İsteğe Bağlı)
						</label>
						<input
							id="entitlement-note"
							type="text"
							className="form-control"
							value={note}
							onChange={(e) => setNote(e.target.value)}
							placeholder="Örn: Zamlı maaş tahmini"
							maxLength={255}
						/>
					</div>

					<div className="form-actions flex justify-end gap-2 mt-6">
						<button
							type="button"
							className="btn btn-secondary"
							onClick={() => void navigate({ to: "/income" })}
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
							data-testid="btn-submit-entitlement"
							disabled={submitting || !sourceId || !amount || !periodMonthUi}
						>
							{submitting ? "Kaydediliyor..." : "Beklenen Geliri Kaydet"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}

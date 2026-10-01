import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { ApiError, isNetworkUncertainError } from "../../api/errors";
import { createIncomeSource } from "../../api/income-api";
import type {
	CreateIncomeSourcePayload,
	IncomeReferenceMethod,
	IncomeSourceNature,
	ProductLedgerAccountItem,
} from "../../api/income-types";
import { fetchAllLedgerAccounts } from "../../api/manual-expenses-api";
import { getIstanbulCalendarDate } from "../../lib/istanbul-date";
import { MoneyInput } from "../common/MoneyInput";
import { LedgerAccountProvisionModal } from "./LedgerAccountProvisionModal";

const SOURCE_CODE_REGEX = /^[A-Z][A-Z0-9_]{1,63}$/;

export function IncomeSourceForm() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const todayIstanbul = getIstanbulCalendarDate().dateString;

	// Form fields
	const [code, setCode] = useState("");
	const [name, setName] = useState("");
	const [nature, setNature] = useState<IncomeSourceNature>("REGULAR");
	const [referenceMethod, setReferenceMethod] =
		useState<IncomeReferenceMethod>("FIXED_MONTHLY");
	const [expectedMonthlyAmount, setExpectedMonthlyAmount] = useState("");
	const [seasonalMonthsPerYear, setSeasonalMonthsPerYear] =
		useState<number>(12);
	const [rollingMedianMonths, setRollingMedianMonths] = useState<number>(6);
	const [incomeLedgerAccountId, setIncomeLedgerAccountId] = useState("");
	const [activeFrom, setActiveFrom] = useState(todayIstanbul);
	const [activeUntil, setActiveUntil] = useState("");

	// Modals & submission state
	const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [uncertainWarning, setUncertainWarning] = useState<string | null>(null);

	// Load all ledger accounts
	const { data: accountsData, isLoading: accountsLoading } = useQuery({
		queryKey: ["ledger-accounts"],
		queryFn: () => fetchAllLedgerAccounts(100),
		staleTime: 60_000,
	});

	// Eligible income ledger accounts: INCOME, normalBalance CREDIT, currency TRY, active
	const eligibleIncomeAccounts = useMemo(() => {
		return (accountsData ?? []).filter(
			(acc) =>
				acc.accountType === "INCOME" &&
				acc.normalBalance === "CREDIT" &&
				acc.currency === "TRY" &&
				!acc.archived,
		);
	}, [accountsData]);

	// Invariant (Section 21): EXTRA and SUPPORT must use EXCLUDED
	const effectiveRefMethod: IncomeReferenceMethod =
		nature === "EXTRA" || nature === "SUPPORT" ? "EXCLUDED" : referenceMethod;

	const handleCodeChange = (val: string) => {
		setCode(val.toUpperCase().replace(/[^A-Z0-9_]/g, ""));
	};

	const handleNatureChange = (newNature: IncomeSourceNature) => {
		setNature(newNature);
		if (newNature === "EXTRA" || newNature === "SUPPORT") {
			setReferenceMethod("EXCLUDED");
		}
	};

	const handleAccountCreated = (account: ProductLedgerAccountItem) => {
		setIncomeLedgerAccountId(account.accountId);
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setFormError(null);
		setUncertainWarning(null);

		const normalizedCode = code.trim().toUpperCase();
		if (!SOURCE_CODE_REGEX.test(normalizedCode)) {
			setFormError(
				"Kaynak kodu bir harfle başlamalı ve yalnızca büyük harf, rakam ve alt çizgi içermelidir (2-64 karakter).",
			);
			return;
		}

		const trimmedName = name.trim();
		if (!trimmedName || trimmedName.length > 120) {
			setFormError("Kaynak adı 1 ile 120 karakter arasında olmalıdır.");
			return;
		}

		if (!incomeLedgerAccountId) {
			setFormError("Lütfen bir muhasebe gelir hesabı seçin.");
			return;
		}

		if (!activeFrom) {
			setFormError("Başlangıç tarihi geçerli bir tarih olmalıdır.");
			return;
		}

		if (activeUntil && activeUntil < activeFrom) {
			setFormError("Bitiş tarihi başlangıç tarihinden önce olamaz.");
			return;
		}

		// Validation by method
		const payload: CreateIncomeSourcePayload = {
			code: normalizedCode,
			name: trimmedName,
			nature,
			referenceMethod: effectiveRefMethod,
			incomeLedgerAccountId,
			activeFrom,
			activeUntil: activeUntil ? activeUntil : null,
		};

		if (effectiveRefMethod === "FIXED_MONTHLY") {
			if (
				!expectedMonthlyAmount ||
				Number.parseFloat(expectedMonthlyAmount) <= 0
			) {
				setFormError("Sabit aylık gelir için pozitif bir tutar girilmelidir.");
				return;
			}
			payload.expectedMonthlyAmount = expectedMonthlyAmount;
		} else if (effectiveRefMethod === "SEASONAL_ANNUALIZED") {
			if (
				!expectedMonthlyAmount ||
				Number.parseFloat(expectedMonthlyAmount) <= 0
			) {
				setFormError("Dönemsel gelir için pozitif bir tutar girilmelidir.");
				return;
			}
			if (seasonalMonthsPerYear < 1 || seasonalMonthsPerYear > 12) {
				setFormError("Yıldaki aktif ay sayısı 1 ile 12 arasında olmalıdır.");
				return;
			}
			payload.expectedMonthlyAmount = expectedMonthlyAmount;
			payload.seasonalMonthsPerYear = seasonalMonthsPerYear;
		} else if (effectiveRefMethod === "ROLLING_MEDIAN") {
			if (rollingMedianMonths < 1 || rollingMedianMonths > 24) {
				setFormError(
					"Geriye dönük medyan ay sayısı 1 ile 24 arasında olmalıdır.",
				);
				return;
			}
			payload.rollingMedianMonths = rollingMedianMonths;
		} else if (effectiveRefMethod === "EXCLUDED") {
			if (
				expectedMonthlyAmount &&
				Number.parseFloat(expectedMonthlyAmount) > 0
			) {
				payload.expectedMonthlyAmount = expectedMonthlyAmount;
			}
		}

		setSubmitting(true);
		try {
			await createIncomeSource(payload);
			await queryClient.invalidateQueries({ queryKey: ["income-sources"] });
			await queryClient.invalidateQueries({ queryKey: ["income-reference"] });
			void navigate({ to: "/income" });
		} catch (err) {
			if (isNetworkUncertainError(err)) {
				setUncertainWarning(
					"Ağ bağlantısı belirsiz. Kaynak oluşturulmuş olabilir. Aynı bilgilerle 'Tekrar Gönder' yapabilirsiniz (doğal tekrar korumalıdır).",
				);
			} else if (err instanceof ApiError) {
				setFormError(err.userMessage);
			} else {
				setFormError(
					"Gelir kaynağı kaydedilirken beklenmeyen bir hata oluştu.",
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
					<h1 className="page-title">Yeni Gelir Kaynağı</h1>
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

				<form onSubmit={handleSubmit} className="income-source-form">
					<div className="form-group mb-3">
						<label htmlFor="source-code" className="form-label">
							Kaynak Kodu
						</label>
						<input
							id="source-code"
							type="text"
							className="form-control"
							value={code}
							onChange={(e) => handleCodeChange(e.target.value)}
							placeholder="MAAS, KYK_BURS, AILE_DESTEGI"
							maxLength={64}
							required
						/>
						<small className="form-text text-secondary">
							Büyük harf, rakam ve alt çizgi (örn: MAAS, BURS_A)
						</small>
					</div>

					<div className="form-group mb-3">
						<label htmlFor="source-name" className="form-label">
							Kaynak Adı
						</label>
						<input
							id="source-name"
							type="text"
							className="form-control"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Şirket Maaşı, KYK Başarı Bursu"
							maxLength={120}
							required
						/>
					</div>

					<div className="form-group mb-3">
						<label htmlFor="source-nature" className="form-label">
							Gelir Türü (Niteliği)
						</label>
						<select
							id="source-nature"
							className="form-control"
							value={nature}
							onChange={(e) =>
								handleNatureChange(e.target.value as IncomeSourceNature)
							}
						>
							<option value="REGULAR">Düzenli Gelir</option>
							<option value="EXTRA">Ek Gelir</option>
							<option value="SUPPORT">Destek</option>
						</select>
					</div>

					<div className="form-group mb-3">
						<label htmlFor="source-ref-method" className="form-label">
							Referans Gelir Yöntemi
						</label>
						<select
							id="source-ref-method"
							className="form-control"
							value={effectiveRefMethod}
							onChange={(e) =>
								setReferenceMethod(e.target.value as IncomeReferenceMethod)
							}
							disabled={nature === "EXTRA" || nature === "SUPPORT"}
						>
							<option value="FIXED_MONTHLY">Sabit Aylık</option>
							<option value="SEASONAL_ANNUALIZED">
								Dönemsel / Yıllığa Yayılmış
							</option>
							<option value="ROLLING_MEDIAN">Son Ayların Medyanı</option>
							<option value="EXCLUDED">Referans Gelire Dahil Değil</option>
						</select>
						{(nature === "EXTRA" || nature === "SUPPORT") && (
							<small className="form-text text-secondary">
								Ek Gelir ve Destek niteliğindeki gelirler zorunlu olarak
								Referans Gelire Dahil Değil olarak kaydedilir.
							</small>
						)}
					</div>

					{/* Method-specific fields */}
					{effectiveRefMethod === "FIXED_MONTHLY" && (
						<div className="form-group mb-3">
							<label htmlFor="source-fixed-amount" className="form-label">
								Beklenen Aylık Tutar
							</label>
							<MoneyInput
								id="source-fixed-amount"
								value={expectedMonthlyAmount}
								onChange={setExpectedMonthlyAmount}
								placeholder="0,00"
								required
							/>
						</div>
					)}

					{effectiveRefMethod === "SEASONAL_ANNUALIZED" && (
						<>
							<div className="form-group mb-3">
								<label htmlFor="source-seasonal-amount" className="form-label">
									Aktif Aylardaki Beklenen Tutar
								</label>
								<MoneyInput
									id="source-seasonal-amount"
									value={expectedMonthlyAmount}
									onChange={setExpectedMonthlyAmount}
									placeholder="0,00"
									required
								/>
							</div>
							<div className="form-group mb-3">
								<label htmlFor="source-seasonal-months" className="form-label">
									Yılda Alınan Ay Sayısı (1 - 12)
								</label>
								<input
									id="source-seasonal-months"
									type="number"
									min={1}
									max={12}
									className="form-control"
									value={seasonalMonthsPerYear}
									onChange={(e) =>
										setSeasonalMonthsPerYear(
											Number.parseInt(e.target.value, 10) || 1,
										)
									}
									required
								/>
								<small className="form-text text-secondary">
									Örneğin yılda 9 ay burs alınıyorsa 9 seçin. Referans gelir
									(Tutar × Ay / 12) olarak hesaplanır.
								</small>
							</div>
						</>
					)}

					{effectiveRefMethod === "ROLLING_MEDIAN" && (
						<div className="form-group mb-3">
							<label htmlFor="source-median-months" className="form-label">
								Geriye Dönük Medyan Ay Sayısı (1 - 24)
							</label>
							<input
								id="source-median-months"
								type="number"
								min={1}
								max={24}
								className="form-control"
								value={rollingMedianMonths}
								onChange={(e) =>
									setRollingMedianMonths(
										Number.parseInt(e.target.value, 10) || 1,
									)
								}
								required
							/>
							<small className="form-text text-secondary">
								Referans tutar sunucu tarafından gerçekleşen tahsilatların son{" "}
								{rollingMedianMonths} aylık medyanı olarak hesaplanacaktır.
							</small>
						</div>
					)}

					{effectiveRefMethod === "EXCLUDED" && (
						<div className="form-group mb-3">
							<label htmlFor="source-excluded-amount" className="form-label">
								Tahmini Tutar (İsteğe Bağlı)
							</label>
							<MoneyInput
								id="source-excluded-amount"
								value={expectedMonthlyAmount}
								onChange={setExpectedMonthlyAmount}
								placeholder="0,00"
							/>
							<small className="form-text text-secondary">
								Bu tutar Referans Gelir hesabına dahil edilmez.
							</small>
						</div>
					)}

					<div className="form-group mb-3">
						<div className="flex justify-between items-center mb-1">
							<label
								htmlFor="source-ledger-account"
								className="form-label mb-0"
							>
								Muhasebe Gelir Hesabı
							</label>
							<button
								type="button"
								className="btn btn-sm btn-outline-primary flex items-center gap-1"
								onClick={() => setIsAccountModalOpen(true)}
							>
								<Plus size={14} aria-hidden="true" />
								<span>Gelir Hesabı Oluştur</span>
							</button>
						</div>
						{accountsLoading ? (
							<p className="text-sm text-secondary">Hesaplar yükleniyor...</p>
						) : (
							<select
								id="source-ledger-account"
								className="form-control"
								value={incomeLedgerAccountId}
								onChange={(e) => setIncomeLedgerAccountId(e.target.value)}
								required
							>
								<option value="">Hesap Seçin...</option>
								{eligibleIncomeAccounts.map((acc) => (
									<option key={acc.accountId} value={acc.accountId}>
										{acc.name} ({acc.code})
									</option>
								))}
							</select>
						)}
						{eligibleIncomeAccounts.length === 0 && !accountsLoading && (
							<small className="form-text text-warning">
								Henüz tanımlı bir gelir hesabı bulunmuyor. Yukarıdaki "Gelir
								Hesabı Oluştur" butonu ile hemen oluşturabilirsiniz.
							</small>
						)}
					</div>

					<div className="grid grid-cols-2 gap-3 mb-4">
						<div className="form-group">
							<label htmlFor="source-active-from" className="form-label">
								Başlangıç Tarihi
							</label>
							<input
								id="source-active-from"
								type="date"
								className="form-control"
								value={activeFrom}
								onChange={(e) => setActiveFrom(e.target.value)}
								required
							/>
						</div>
						<div className="form-group">
							<label htmlFor="source-active-until" className="form-label">
								Bitiş Tarihi (İsteğe Bağlı)
							</label>
							<input
								id="source-active-until"
								type="date"
								className="form-control"
								value={activeUntil}
								onChange={(e) => setActiveUntil(e.target.value)}
							/>
						</div>
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
						<button
							type="submit"
							className="btn btn-primary"
							data-testid="btn-submit-source"
							disabled={submitting || !code || !name || !incomeLedgerAccountId}
						>
							{submitting ? "Kaydediliyor..." : "Gelir Kaynağını Kaydet"}
						</button>
					</div>
				</form>
			</div>

			<LedgerAccountProvisionModal
				isOpen={isAccountModalOpen}
				accountType="INCOME"
				onClose={() => setIsAccountModalOpen(false)}
				onAccountCreated={handleAccountCreated}
			/>
		</div>
	);
}

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, isNetworkUncertainError } from "../../api/errors";
import { createProductLedgerAccount } from "../../api/income-api";
import type { ProductLedgerAccountItem } from "../../api/income-types";
import { AccessibleModal } from "../common/AccessibleModal";

interface LedgerAccountProvisionModalProps {
	isOpen: boolean;
	accountType: "INCOME" | "ASSET";
	onClose: () => void;
	onAccountCreated: (account: ProductLedgerAccountItem) => void;
}

const PRODUCT_ALIAS_REGEX = /^[A-Z0-9_]{1,60}$/;

export function LedgerAccountProvisionModal({
	isOpen,
	accountType,
	onClose,
	onAccountCreated,
}: LedgerAccountProvisionModalProps) {
	const queryClient = useQueryClient();
	const [code, setCode] = useState("");
	const [name, setName] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [uncertainWarning, setUncertainWarning] = useState<string | null>(null);

	const title =
		accountType === "INCOME"
			? "Yeni Gelir Hesabı Oluştur"
			: "Yeni Kasa / Banka Hesabı Oluştur";

	const handleCodeChange = (val: string) => {
		setCode(val.toUpperCase().replace(/[^A-Z0-9_]/g, ""));
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		setUncertainWarning(null);

		const normalizedCode = code.trim().toUpperCase();
		if (!normalizedCode || !PRODUCT_ALIAS_REGEX.test(normalizedCode)) {
			setError(
				"Hesap kodu 1-60 karakter, büyük harf, rakam veya alt çizgi olmalıdır.",
			);
			return;
		}

		const trimmedName = name.trim();
		if (!trimmedName || trimmedName.length > 100) {
			setError("Hesap adı 1-100 karakter arasında olmalıdır.");
			return;
		}

		setSubmitting(true);
		try {
			const res = await createProductLedgerAccount({
				code: normalizedCode,
				name: trimmedName,
				accountType,
			});

			await queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] });
			onAccountCreated(res);
			onClose();
		} catch (err) {
			if (isNetworkUncertainError(err)) {
				setUncertainWarning(
					"Ağ bağlantısı belirsiz. Hesap oluşturulmuş olabilir. Lütfen 'Tekrar Dene' ile aynı bilgilerle yeniden gönderebilirsiniz.",
				);
			} else if (err instanceof ApiError) {
				setError(err.userMessage);
			} else {
				setError("Hesap oluşturulurken beklenmeyen bir hata oluştu.");
			}
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<AccessibleModal
			isOpen={isOpen}
			onClose={onClose}
			title={title}
			variant="center-dialog"
		>
			<form onSubmit={handleSubmit} className="account-provision-form">
				<p className="text-secondary text-sm mb-4">
					{accountType === "INCOME"
						? "Bu hesap, tanımlayacağınız gelir kaynağının muhasebe kaydı için kullanılacaktır."
						: "Bu hesap, tahsil edilen gelirlerin aktarılacağı kasa/banka varlık hesabıdır."}
				</p>

				{error && (
					<div className="alert alert-danger mb-4" role="alert">
						{error}
					</div>
				)}

				{uncertainWarning && (
					<div className="alert alert-warning mb-4" role="alert">
						{uncertainWarning}
					</div>
				)}

				<div className="form-group mb-3">
					<label htmlFor="provision-code" className="form-label">
						Hesap Kodu (Takma Ad)
					</label>
					<input
						id="provision-code"
						type="text"
						className="form-control"
						value={code}
						onChange={(e) => handleCodeChange(e.target.value)}
						placeholder={accountType === "INCOME" ? "GELIR_MAAS" : "KASA_NAKIT"}
						maxLength={60}
						required
					/>
					<small className="form-text text-secondary">
						Yalnızca büyük harf, rakam ve alt çizgi (örn.{" "}
						{accountType === "INCOME" ? "BURS_KYK" : "VAKIF_BANKA"})
					</small>
				</div>

				<div className="form-group mb-4">
					<label htmlFor="provision-name" className="form-label">
						Hesap Adı
					</label>
					<input
						id="provision-name"
						type="text"
						className="form-control"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder={
							accountType === "INCOME" ? "Maaş Geliri" : "Ana Vadesiz Hesap"
						}
						maxLength={100}
						required
					/>
				</div>

				<div className="modal-actions flex justify-end gap-2">
					<button
						type="button"
						className="btn btn-secondary"
						onClick={onClose}
						disabled={submitting}
					>
						İptal
					</button>
					<button
						type="submit"
						className="btn btn-primary"
						data-testid="btn-create-account-submit"
						disabled={submitting || !code || !name}
					>
						{submitting ? "Oluşturuluyor..." : "Hesabı Oluştur"}
					</button>
				</div>
			</form>
		</AccessibleModal>
	);
}

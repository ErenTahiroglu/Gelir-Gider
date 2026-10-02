import type React from "react";
import { useState } from "react";
import { useAuth } from "../../auth/auth-context";

export function PairingFlow() {
	const { state, cancelPairingFlow, submitPairingCode } = useAuth();

	const [pairingCode, setPairingCode] = useState("");
	const [deviceName, setDeviceName] = useState(
		navigator.userAgent.includes("Android") ? "Honor 90" : "Mobil Cihaz",
	);
	const [localError, setLocalError] = useState<string | null>(null);
	const [isSubmittingPairing, setIsSubmittingPairing] = useState(false);

	const errorMessage =
		localError ||
		(state.status === "PAIRING_REQUIRED" ? state.error : undefined);

	const handlePairingSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setLocalError(null);

		const trimmedCode = pairingCode.trim();
		if (!trimmedCode) {
			setLocalError("Lütfen eşleme kodunuzu girin.");
			return;
		}

		setIsSubmittingPairing(true);
		try {
			await submitPairingCode(trimmedCode, deviceName.trim() || "Mobil Cihaz");
		} catch (err) {
			setLocalError(
				err instanceof Error
					? err.message
					: "Eşleme kodu doğrulanamadı. Lütfen kodu kontrol edin.",
			);
		} finally {
			setIsSubmittingPairing(false);
		}
	};

	return (
		<main className="auth-surface" data-testid="unlock-screen">
			<div className="auth-card">
				<header className="auth-header">
					<h1 className="auth-title">Yeni Cihaz Bağla</h1>
					<p className="auth-subtitle">
						Ana cihazınızdan (Mac) oluşturulan tek kullanımlık eşleme kodunu
						girerek bu cihaz için Passkey oluşturun.
					</p>
				</header>

				{errorMessage && (
					<div
						className="auth-alert"
						role="alert"
						aria-live="polite"
						data-testid="pairing-error-alert"
					>
						{errorMessage}
					</div>
				)}

				<form
					onSubmit={(e) => void handlePairingSubmit(e)}
					className="auth-form"
					data-testid="pairing-form"
				>
					<div className="form-group">
						<label htmlFor="pairing-code-input">Eşleme Kodu</label>
						<input
							id="pairing-code-input"
							type="text"
							className="input-field tabular-nums"
							value={pairingCode}
							onChange={(e) => setPairingCode(e.target.value)}
							placeholder="Eşleme kodunu yapıştırın veya girin"
							autoComplete="off"
							disabled={isSubmittingPairing}
							data-testid="pairing-code-input"
						/>
					</div>

					<div className="form-group">
						<label htmlFor="pairing-device-name-input">Cihaz Adı</label>
						<input
							id="pairing-device-name-input"
							type="text"
							className="input-field"
							value={deviceName}
							onChange={(e) => setDeviceName(e.target.value)}
							placeholder="Örn: Honor 90"
							disabled={isSubmittingPairing}
							data-testid="pairing-device-name-input"
						/>
					</div>

					<div className="auth-actions">
						<button
							type="submit"
							className="btn btn-primary"
							disabled={isSubmittingPairing || !pairingCode.trim()}
							data-testid="submit-pairing-button"
						>
							{isSubmittingPairing
								? "Yetkilendiriliyor..."
								: "Cihazı Bağla ve Passkey Oluştur"}
						</button>

						<button
							type="button"
							className="btn btn-link"
							onClick={() => {
								setLocalError(null);
								setPairingCode("");
								cancelPairingFlow();
							}}
							disabled={isSubmittingPairing}
							data-testid="cancel-pairing-button"
						>
							Giriş ekranına dön
						</button>
					</div>
				</form>
			</div>
		</main>
	);
}
export default PairingFlow;

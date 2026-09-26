import type React from "react";
import { useState } from "react";
import { useAuth } from "../../auth/auth-context";

export function RecoveryFlow() {
	const { state, submitRecoveryCode, cancelRecoveryFlow } = useAuth();
	const [recoveryCode, setRecoveryCode] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);

	const isRecovering = state.status === "RECOVERING";
	const errorMessage =
		localError ||
		(state.status === "RECOVERY_REQUIRED" ? state.error : undefined);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setLocalError(null);

		if (!recoveryCode.trim()) {
			setLocalError("Lütfen kurtarma kodunuzu girin.");
			return;
		}

		await submitRecoveryCode(recoveryCode.trim());
		setRecoveryCode("");
	};

	return (
		<main className="auth-surface" data-testid="recovery-flow">
			<div className="auth-card">
				<header className="auth-header">
					<h1 className="auth-title">Hesap Kurtarma</h1>
					<p className="auth-subtitle">
						Daha önce oluşturulmuş kurtarma kodunuzu girerek yeni bir Passkey
						tanımlayabilirsiniz.
					</p>
				</header>

				{errorMessage && (
					<div
						className="auth-alert"
						role="alert"
						aria-live="polite"
						data-testid="recovery-error-alert"
					>
						{errorMessage}
					</div>
				)}

				<form onSubmit={(e) => void handleSubmit(e)} className="auth-form">
					<div className="form-group">
						<label htmlFor="recovery-code-input">Kurtarma Kodu</label>
						<input
							id="recovery-code-input"
							type="text"
							className="input-field tabular-nums"
							value={recoveryCode}
							onChange={(e) => setRecoveryCode(e.target.value)}
							placeholder="XXXX-XXXX-XXXX-XXXX"
							autoComplete="off"
							disabled={isRecovering}
							data-testid="recovery-code-input"
						/>
					</div>

					<div className="auth-actions">
						<button
							type="submit"
							className="btn btn-primary"
							disabled={isRecovering}
							data-testid="submit-recovery-code-button"
						>
							{isRecovering ? "Doğrulanıyor..." : "Doğrula ve İlerle"}
						</button>

						<button
							type="button"
							className="btn btn-link"
							onClick={cancelRecoveryFlow}
							disabled={isRecovering}
							data-testid="cancel-recovery-button"
						>
							Giriş ekranına dön
						</button>
					</div>
				</form>
			</div>
		</main>
	);
}

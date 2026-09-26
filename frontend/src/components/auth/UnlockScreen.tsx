import { useAuth } from "../../auth/auth-context";

export function UnlockScreen() {
	const { state, authenticateWithPasskey, startRecoveryFlow } = useAuth();

	const isAuthenticating = state.status === "AUTHENTICATING";
	const errorMessage =
		state.status === "AUTH_REQUIRED" ? state.error : undefined;

	return (
		<main className="auth-surface" data-testid="unlock-screen">
			<div className="auth-card">
				<header className="auth-header">
					<h1 className="auth-title">Gelir-Gider</h1>
					<p className="auth-subtitle">
						Finansal bilgilerinizi görmek için Passkey ile doğrulayın.
					</p>
				</header>

				{errorMessage && (
					<div
						className="auth-alert"
						role="alert"
						aria-live="polite"
						data-testid="auth-error-alert"
					>
						{errorMessage}
					</div>
				)}

				<div className="auth-actions">
					<button
						type="button"
						className="btn btn-primary"
						onClick={() => void authenticateWithPasskey()}
						disabled={isAuthenticating}
						data-testid="unlock-passkey-button"
					>
						{isAuthenticating ? "Doğrulanıyor..." : "Passkey ile Kilidi Aç"}
					</button>

					<button
						type="button"
						className="btn btn-link"
						onClick={startRecoveryFlow}
						disabled={isAuthenticating}
						data-testid="use-recovery-code-link"
					>
						Kurtarma kodu kullan
					</button>
				</div>
			</div>
		</main>
	);
}

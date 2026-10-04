import { useAuth } from "../../auth/auth-context";

export function UnlockScreen() {
	const {
		state,
		authenticateWithPasskey,
		startRecoveryFlow,
		startPairingFlow,
	} = useAuth();

	const isAuthenticating = state.status === "AUTHENTICATING";
	const errorMessage =
		state.status === "AUTH_REQUIRED" ? state.error : undefined;

	return (
		<main className="auth-surface" data-testid="unlock-screen">
			<div className="auth-card">
				<header className="auth-header">
					<span className="auth-brand-mark theme-brand-mark" aria-hidden="true">
						<img
							src="/brand/mark-light-ui.svg"
							alt=""
							width="48"
							height="48"
							className="theme-brand-mark-light"
						/>
						<img
							src="/brand/mark-dark-ui.svg"
							alt=""
							width="48"
							height="48"
							className="theme-brand-mark-dark"
						/>
					</span>
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
						className="btn btn-secondary"
						onClick={startPairingFlow}
						disabled={isAuthenticating}
						data-testid="start-pairing-button"
					>
						Yeni cihaz bağla
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
export default UnlockScreen;

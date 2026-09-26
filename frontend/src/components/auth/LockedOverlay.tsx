import { useAuth } from "../../auth/auth-context";

export function LockedOverlay() {
	const { state, reauthenticateWithPasskey, logout } = useAuth();

	const isReauthenticating = state.status === "REAUTHENTICATING";
	const errorMessage =
		state.status === "REAUTH_REQUIRED" ? state.error : undefined;

	return (
		<div
			className="locked-overlay"
			role="dialog"
			aria-modal="true"
			aria-labelledby="locked-title"
			data-testid="locked-overlay"
		>
			<div className="auth-card locked-card">
				<header className="auth-header">
					<h2 id="locked-title" className="auth-title">
						Gelir-Gider kilitli
					</h2>
					<p className="auth-subtitle">
						Devam etmek için Passkey ile doğrulayın.
					</p>
				</header>

				{errorMessage && (
					<div
						className="auth-alert"
						role="alert"
						aria-live="polite"
						data-testid="reauth-error-alert"
					>
						{errorMessage}
					</div>
				)}

				<div className="auth-actions">
					<button
						type="button"
						className="btn btn-primary"
						onClick={() => void reauthenticateWithPasskey()}
						disabled={isReauthenticating}
						data-testid="reauth-passkey-button"
					>
						{isReauthenticating ? "Doğrulanıyor..." : "Kilidi Aç"}
					</button>

					<button
						type="button"
						className="btn btn-secondary"
						onClick={() => void logout()}
						disabled={isReauthenticating}
						data-testid="locked-logout-button"
					>
						Çıkış Yap
					</button>
				</div>
			</div>
		</div>
	);
}

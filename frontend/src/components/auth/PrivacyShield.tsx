export function PrivacyShield() {
	return (
		<div
			className="privacy-shield"
			role="presentation"
			aria-hidden="true"
			data-testid="privacy-shield"
		>
			<div className="privacy-shield-content">
				<span
					className="privacy-shield-mark theme-brand-mark"
					aria-hidden="true"
				/>
				<span className="privacy-shield-logo">Gelir-Gider</span>
				<p className="privacy-shield-subtitle">Finansal bilgiler gizlendi</p>
			</div>
		</div>
	);
}

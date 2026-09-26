export interface ApiErrorPayload {
	error?: {
		code?: string;
		message?: string;
	};
}

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly requestId: string | null;
	readonly retryAfter: number | null;
	readonly userMessage: string;

	constructor(params: {
		status: number;
		code: string;
		message: string;
		requestId?: string | null;
		retryAfter?: number | null;
	}) {
		const userMessage = mapErrorCodeToUserMessage(params.code, params.message);
		super(userMessage);
		this.name = "ApiError";
		this.status = params.status;
		this.code = params.code;
		this.requestId = params.requestId ?? null;
		this.retryAfter = params.retryAfter ?? null;
		this.userMessage = userMessage;
	}
}

export function mapErrorCodeToUserMessage(
	code: string,
	fallback?: string,
): string {
	switch (code) {
		case "UNAUTHENTICATED":
			return "Oturum süreniz doldu veya oturum açılmadı. Lütfen tekrar doğrulayın.";
		case "AUTH_NOT_INITIALIZED":
			return "Sistem henüz kurulmamış. İlk kurulum adımlarını tamamlayın.";
		case "AUTH_STATE_INCONSISTENT":
			return "Kimlik doğrulama durumunda tutarsızlık algılandı. Lütfen yönetici ile iletişime geçin.";
		case "INVALID_ORIGIN":
			return "İstek kaynağı geçersiz. Lütfen sayfayı yenileyip tekrar deneyin.";
		case "AUTH_RATE_LIMITED":
			return "Çok fazla deneme yapıldı. Lütfen bir süre bekleyip tekrar deneyin.";
		case "AUTH_RATE_LIMIT_UNAVAILABLE":
			return "Güvenlik koruması geçici olarak kullanılamıyor. Lütfen az sonra tekrar deneyin.";
		case "WEBAUTHN_CHALLENGE_INVALID":
			return "Güvenlik doğrulaması zaman aşımına uğradı. Lütfen tekrar deneyin.";
		case "WEBAUTHN_CREDENTIAL_NOT_FOUND":
			return "Bu cihazda kayıtlı bir Passkey bulunamadı.";
		case "WEBAUTHN_CREDENTIAL_STATE_CHANGED":
			return "Passkey durumu değişti. Güvenlik nedeniyle lütfen kurtarma kodunuzu kullanın.";
		case "WEBAUTHN_AUTHENTICATION_FAILED":
			return "Passkey doğrulaması tamamlanamadı. Lütfen tekrar deneyin.";
		case "WEBAUTHN_REGISTRATION_FAILED":
			return "Yeni Passkey kaydı tamamlanamadı. Lütfen tekrar deneyin.";
		case "SESSION_ESTABLISHMENT_FAILED":
			return "Passkey doğrulandı ancak oturum oluşturulamadı. Lütfen tekrar deneyin.";
		case "SESSION_REVOCATION_FAILED":
			return "Oturum sonlandırılamadı. Lütfen sayfayı yenileyin.";
		case "RECOVERY_CODE_INVALID":
			return "Girilen kurtarma kodu geçersiz veya daha önce kullanılmış.";
		case "BOOTSTRAP_INVALID":
			return "Girilen kurulum anahtarı (bootstrap token) geçersiz.";
		case "BOOTSTRAP_ALREADY_COMPLETED":
			return "İlk kurulum zaten daha önce tamamlanmış.";
		case "ENROLLMENT_GRANT_INVALID":
			return "Kayıt izni geçersiz. Lütfen işlemi baştan başlatın.";
		case "ENROLLMENT_GRANT_EXPIRED":
			return "Kayıt izninin süresi doldu. Lütfen işlemi baştan başlatın.";
		case "CREDENTIAL_ALREADY_REGISTERED":
			return "Bu Passkey zaten kayıtlı.";
		case "INVALID_DEVICE_NAME":
			return "Geçersiz cihaz adı. Lütfen geçerli bir ad girin.";
		case "INVALID_DISPLAY_NAME":
			return "Geçersiz kullanıcı adı. Lütfen geçerli bir ad girin.";
		case "NETWORK_ERROR":
			return "Sunucuya bağlanılamadı. İnternet bağlantınızı kontrol edin.";
		case "UNPARSEABLE_RESPONSE":
			return "Sunucudan beklenmeyen bir yanıt alındı.";
		case "WEBAUTHN_NOT_SUPPORTED":
			return "Bu cihaz veya tarayıcı Passkey doğrulamasını desteklemiyor.";
		case "WEBAUTHN_CANCELLED":
			return "Passkey doğrulaması tamamlanmadı. Tekrar deneyebilirsiniz.";
		default:
			return fallback && fallback.trim() !== ""
				? fallback
				: "Bir hata oluştu. Lütfen tekrar deneyin.";
	}
}

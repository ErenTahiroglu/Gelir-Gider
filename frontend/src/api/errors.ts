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

const CORE_ERROR_MESSAGES: Record<string, string> = {
	UNAUTHENTICATED:
		"Oturum süreniz doldu veya oturum açılmadı. Lütfen tekrar doğrulayın.",
	AUTH_NOT_INITIALIZED:
		"Sistem henüz kurulmamış. İlk kurulum adımlarını tamamlayın.",
	AUTH_STATE_INCONSISTENT:
		"Kimlik doğrulama durumunda tutarsızlık algılandı. Lütfen yönetici ile iletişime geçin.",
	INVALID_ORIGIN:
		"İstek kaynağı geçersiz. Lütfen sayfayı yenileyip tekrar deneyin.",
	AUTH_RATE_LIMITED:
		"Çok fazla deneme yapıldı. Lütfen bir süre bekleyip tekrar deneyin.",
	AUTH_RATE_LIMIT_UNAVAILABLE:
		"Güvenlik koruması geçici olarak kullanılamıyor. Lütfen az sonra tekrar deneyin.",
	WEBAUTHN_CHALLENGE_INVALID:
		"Güvenlik doğrulaması zaman aşımına uğradı. Lütfen tekrar deneyin.",
	WEBAUTHN_CREDENTIAL_NOT_FOUND: "Bu cihazda kayıtlı bir Passkey bulunamadı.",
	WEBAUTHN_CREDENTIAL_STATE_CHANGED:
		"Passkey durumu değişti. Güvenlik nedeniyle lütfen kurtarma kodunuzu kullanın.",
	WEBAUTHN_AUTHENTICATION_FAILED:
		"Passkey doğrulaması tamamlanamadı. Lütfen tekrar deneyin.",
	WEBAUTHN_REGISTRATION_FAILED:
		"Yeni Passkey kaydı tamamlanamadı. Lütfen tekrar deneyin.",
	SESSION_ESTABLISHMENT_FAILED:
		"Passkey doğrulandı ancak oturum oluşturulamadı. Lütfen tekrar deneyin.",
	SESSION_REVOCATION_FAILED:
		"Oturum sonlandırılamadı. Lütfen sayfayı yenileyin.",
	RECOVERY_CODE_INVALID:
		"Girilen kurtarma kodu geçersiz veya daha önce kullanılmış.",
	BOOTSTRAP_INVALID: "Girilen kurulum anahtarı (bootstrap token) geçersiz.",
	BOOTSTRAP_ALREADY_COMPLETED: "İlk kurulum zaten daha önce tamamlanmış.",
	ENROLLMENT_GRANT_INVALID:
		"Kayıt izni geçersiz. Lütfen işlemi baştan başlatın.",
	ENROLLMENT_GRANT_EXPIRED:
		"Kayıt izninin süresi doldu. Lütfen işlemi baştan başlatın.",
	CREDENTIAL_ALREADY_REGISTERED: "Bu Passkey zaten kayıtlı.",
	INVALID_DEVICE_NAME: "Geçersiz cihaz adı. Lütfen geçerli bir ad girin.",
	INVALID_DISPLAY_NAME: "Geçersiz kullanıcı adı. Lütfen geçerli bir ad girin.",
	NETWORK_ERROR: "Sunucuya bağlanılamadı. İnternet bağlantınızı kontrol edin.",
	UNPARSEABLE_RESPONSE: "Sunucudan beklenmeyen bir yanıt alındı.",
	WEBAUTHN_NOT_SUPPORTED:
		"Bu cihaz veya tarayıcı Passkey doğrulamasını desteklemiyor.",
	WEBAUTHN_CANCELLED:
		"Passkey doğrulaması tamamlanmadı. Tekrar deneyebilirsiniz.",
};

const domainErrorRegistry: Record<string, string> = {};

let domainErrorsPromise: Promise<void> | null = null;

export function ensureDomainErrorsLoaded(): Promise<void> {
	if (!domainErrorsPromise) {
		domainErrorsPromise = import("./domain-errors").then(() => undefined);
	}
	return domainErrorsPromise;
}

export function registerDomainErrorMessages(
	messages: Record<string, string>,
): void {
	Object.assign(domainErrorRegistry, messages);
}

export function mapErrorCodeToUserMessage(
	code: string,
	fallback?: string,
): string {
	const mapped = CORE_ERROR_MESSAGES[code] || domainErrorRegistry[code];
	if (mapped) {
		return mapped;
	}
	return fallback && fallback.trim() !== ""
		? fallback
		: "Bir hata oluştu. Lütfen tekrar deneyin.";
}

export function isNetworkUncertainError(err: unknown): boolean {
	if (err instanceof ApiError) {
		return err.status === 0 || err.code === "NETWORK_ERROR";
	}
	if (err instanceof Error) {
		const msg = err.message.toLowerCase();
		return (
			msg.includes("network") || msg.includes("fetch") || msg.includes("abort")
		);
	}
	return false;
}

export function getApiErrorMessage(err: unknown): string {
	if (err instanceof ApiError) {
		return err.userMessage;
	}
	if (err instanceof Error) {
		return err.message;
	}
	return "Beklenmeyen bir hata oluştu.";
}

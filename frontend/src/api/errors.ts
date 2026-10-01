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
		case "PEOPLE_INVALID_INPUT":
			return "Girilen bilgiler geçersiz. Lütfen alanları kontrol edin.";
		case "PEOPLE_LEDGER_ACCOUNT_INVALID":
			return "Seçilen hesap geçerli değil veya bu işlem için uygun değil.";
		case "PEOPLE_NOT_FOUND":
			return "Kişi kaydı bulunamadı.";
		case "PEOPLE_NOT_ACTIVE":
			return "Bu kişi kaydı aktif değil veya arşivlenmiş.";
		case "PEOPLE_REVISION_CONFLICT":
			return "Kişi bilgileri başka bir işlem tarafından güncellendi. Lütfen sayfayı yenileyip tekrar deneyin.";
		case "PEOPLE_OBLIGATION_NOT_FOUND":
			return "Borç/alacak kaydı bulunamadı.";
		case "PEOPLE_OBLIGATION_NOT_ACTIVE":
			return "Bu borç/alacak kaydı aktif değil veya kapatılmış.";
		case "PEOPLE_OBLIGATION_REVISION_CONFLICT":
			return "Borç/alacak kaydı başka bir işlem tarafından güncellendi. Lütfen sayfayı yenileyip tekrar deneyin.";
		case "PEOPLE_OBLIGATION_SETTLEMENT_CONFLICT":
			return "Bu borç/alacak için daha önce ödeme kaydı bulunduğu için bu değişiklik yapılamıyor.";
		case "PEOPLE_OBLIGATION_OVERSETTLEMENT":
			return "Ödeme tutarı kalan borç/alacak tutarından fazla olamaz.";
		case "PEOPLE_OBLIGATION_SPLIT_MANAGED":
			return "Bu alacak kart harcaması bölüşümünden oluşturuldu. Tutarı değiştirmek için ilgili ortak harcamayı düzenleyin.";
		case "PEOPLE_PERSON_HAS_OUTSTANDING_BALANCE":
			return "Bu kişide açık borç/alacak bulunduğu için arşivlenemiyor.";
		case "PEOPLE_SETTLEMENT_NOT_FOUND":
			return "Ödeme kaydı bulunamadı.";
		case "PEOPLE_SETTLEMENT_NOT_ACTIVE":
			return "Bu ödeme kaydı aktif değil veya iptal edilmiş.";
		case "PEOPLE_IDEMPOTENCY_CONFLICT":
			return "Bu işlem daha önce farklı bilgilerle gönderilmiş. Lütfen işlemi yenileyin.";
		case "PEOPLE_NO_OPEN_RECEIVABLES":
			return "Bu kişinin tahsil edilecek açık alacağı bulunmuyor.";
		// Short-Term Goals
		case "SHORT_TERM_GOAL_INVALID_INPUT":
			return "Girilen hedef bilgileri geçersiz. Lütfen alanları kontrol edin.";
		case "SHORT_TERM_GOAL_NOT_FOUND":
			return "Kısa vadeli hedef bulunamadı.";
		case "SHORT_TERM_GOAL_NOT_ACTIVE":
			return "Bu hedef aktif durumda değil.";
		case "SHORT_TERM_GOAL_NON_ZERO_BALANCE":
		case "SHORT_TERM_GOAL_BALANCE_NOT_ZERO":
			return "Bu hedefte ayrılmış para bulunduğu için işlem tamamlanamaz. Önce bakiyeyi serbest bırakın.";
		case "SHORT_TERM_GOAL_BUCKET_NOT_FOUND":
			return "Hedefe ait Midas bütçe havuzu bulunamadı.";
		case "SHORT_TERM_GOAL_MIDAS_ACCOUNT_NOT_FOUND":
			return "Midas likidite hesabı bulunamadı. Lütfen önce Midas hesabını bağlayın.";
		case "SHORT_TERM_GOAL_MAX_BUDGET_EXCEEDED":
			return "Toplam hedef birikimi belirlenen azami bütçeyi aşamaz.";
		case "SHORT_TERM_GOAL_PRIORITY_COLLISION":
		case "SHORT_TERM_GOAL_PRIORITY_MISMATCH":
		case "SHORT_TERM_GOAL_PRIORITY_CONFLICT":
			return "Hedef öncelik sıralamasında çakışma oluştu. Lütfen güncel listeyi inceleyip tekrar sıralayın.";
		case "SHORT_TERM_GOAL_REVISION_CONFLICT":
			return "Hedef bilgileri başka bir işlem tarafından güncellendi. Lütfen sayfayı yenileyip tekrar deneyin.";
		case "SHORT_TERM_GOAL_INSUFFICIENT_FREE_BALANCE":
			return "Midas serbest bakiyeniz bu fonlama için yetersiz.";
		case "SHORT_TERM_GOAL_INSUFFICIENT_BALANCE":
			return "Hedef havuzunda çekilmek istenen tutarda bakiye bulunmuyor.";
		case "SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT":
			return "Bu işlem daha önce farklı bilgilerle gönderilmiş. Lütfen işlemi yenileyin.";
		// Midas
		case "MIDAS_INVALID_INPUT":
			return "Girilen Midas bilgileri geçersiz.";
		case "MIDAS_ACCOUNT_NOT_FOUND":
			return "Midas likidite hesabı bulunamadı.";
		case "MIDAS_ACCOUNT_CONFLICT":
			return "Bu kullanıcı için zaten bir Midas hesabı bağlı.";
		case "MIDAS_LEDGER_ACCOUNT_INVALID":
			return "Seçilen kasa/banka hesabı Midas likidite hesabı için uygun değil.";
		case "MIDAS_BUCKET_NOT_FOUND":
			return "İlgili Midas havuzu bulunamadı.";
		case "MIDAS_BUCKET_CONFLICT":
			return "Bu isim veya koda sahip bir Midas havuzu zaten mevcut.";
		case "MIDAS_INSUFFICIENT_FREE_BALANCE":
			return "Midas serbest / dağıtılmamış bakiyesi yetersiz.";
		case "MIDAS_INSUFFICIENT_BUCKET_BALANCE":
			return "Havuz bakiyesi bu aktarım için yetersiz.";
		case "MIDAS_IDEMPOTENCY_CONFLICT":
			return "Bu transfer daha önce farklı bilgilerle gönderilmiş. Lütfen işlemi yenileyin.";
		case "MIDAS_TRANSFER_NOT_FOUND":
			return "Midas transfer kaydı bulunamadı.";
		case "MIDAS_TRANSFER_ALREADY_REVERSED":
			return "Bu transfer kaydı daha önce tersine çevrilmiş.";
		case "MIDAS_BUCKET_INACTIVE":
			return "Bu Midas havuzu aktif değil.";
		case "MIDAS_BUCKET_CAP_EXCEEDED":
			return "Havuz için belirlenen azami limit aşılıyor.";
		case "MIDAS_LONG_TERM_BUCKET_RESTRICTED":
			return "Uzun vadeli yatırım havuzuna genel transfer yapılamaz. Lütfen Uzun Vadeli Görevler akışını kullanın.";
		// Long-Term
		case "LONG_TERM_INVALID_INPUT":
			return "Girilen uzun vadeli görev bilgileri geçersiz.";
		case "LONG_TERM_TASK_NOT_FOUND":
			return "Uzun vadeli yatırım görevi bulunamadı.";
		case "LONG_TERM_TASK_NOT_PENDING":
			return "Bu görev bekleme durumunda değil.";
		case "LONG_TERM_TASK_NOT_SENT":
			return "Bu görev gönderildi durumunda değil.";
		case "LONG_TERM_TASK_CANCELLED":
			return "Bu görev iptal edilmiş ve üzerinde işlem yapılamaz.";
		case "LONG_TERM_REVISION_CONFLICT":
			return "Görev başka bir işlem tarafından güncellendi. Lütfen sayfayı yenileyip tekrar deneyin.";
		case "LONG_TERM_IDEMPOTENCY_CONFLICT":
			return "Bu görev işlemi daha önce farklı bilgilerle gönderilmiş. Lütfen işlemi yenileyin.";
		case "LONG_TERM_INSUFFICIENT_UNALLOCATED":
			return "Midas serbest bakiyesi bu görev tutarını karşılamak için yetersiz.";

		// Income (F8)
		case "INCOME_INVALID_INPUT":
			return "Girilen gelir bilgileri geçersiz. Lütfen alanları kontrol edin.";
		case "INCOME_SOURCE_NOT_FOUND":
			return "Gelir kaynağı bulunamadı.";
		case "INCOME_SOURCE_ARCHIVED":
			return "Bu gelir kaynağı arşivlenmiş ve üzerinde işlem yapılamaz.";
		case "INCOME_SOURCE_CODE_CONFLICT":
			return "Bu kaynak koduyla tanımlı bir gelir kaynağı zaten mevcut.";
		case "INCOME_LEDGER_ACCOUNT_INVALID":
			return "Seçilen muhasebe hesabı gelir kaynağı için uygun değil.";
		case "INCOME_DESTINATION_ACCOUNT_INVALID":
			return "Seçilen kasa/banka hesabı tahsilat için uygun değil.";
		case "INCOME_ENTITLEMENT_NOT_FOUND":
			return "Beklenen gelir kaydı bulunamadı.";
		case "INCOME_ENTITLEMENT_PERIOD_CONFLICT":
			return "Bu gelir kaynağı için bu döneme ait beklenen gelir zaten mevcut.";
		case "INCOME_ENTITLEMENT_REVISION_CONFLICT":
			return "Beklenen gelir bilgileri başka bir işlem tarafından güncellendi. Lütfen sayfayı yenileyip tekrar deneyin.";
		case "INCOME_ENTITLEMENT_ALREADY_VOIDED":
			return "Bu beklenen gelir zaten iptal edilmiş.";
		case "INCOME_RECEIPT_NOT_FOUND":
			return "Gerçekleşen gelir tahsilat kaydı bulunamadı.";
		case "INCOME_RECEIPT_REVISION_CONFLICT":
			return "Tahsilat bilgileri başka bir işlem tarafından güncellendi. Lütfen sayfayı yenileyip tekrar deneyin.";
		case "INCOME_RECEIPT_ALREADY_VOIDED":
			return "Bu tahsilat kaydı zaten iptal edilmiş.";
		case "INCOME_SETTLEMENT_NOT_FOUND":
			return "Henüz beklenen gelir eşleştirmesi yapılmadı.";
		case "INCOME_SETTLEMENT_CONFLICT":
			return "Bu beklenen gelir bir tahsilatla eşleştirildiği için doğrudan iptal edilemiyor. Önce tahsilat eşleştirmesini düzeltin.";
		case "INCOME_SETTLEMENT_ALREADY_EXISTS":
			return "Bu tahsilat için zaten bir eşleştirme kaydı mevcut.";
		case "INCOME_SETTLEMENT_REVISION_CONFLICT":
			return "Eşleştirme bilgileri başka bir işlem tarafından güncellendi. Lütfen güncel durumu kontrol edin.";
		case "INCOME_IDEMPOTENCY_CONFLICT":
			return "Bu işlem daha önce farklı bilgilerle gönderilmiş. Lütfen işlemi yenileyin.";

		// Month Close (F8)
		case "MONTH_CLOSE_INVALID_INPUT":
			return "Dönem kapatma parametreleri geçersiz.";
		case "MONTH_CLOSE_PERIOD_NOT_ENDED":
			return "Bu dönem henüz tamamlanmadığı için kapatılamaz.";
		case "MONTH_CLOSE_BUDGET_PLAN_NOT_FOUND":
			return "Bu dönem için bütçe planı bulunamadı. Dönem kapatılamaz.";
		case "MONTH_CLOSE_BUDGET_PLAN_NOT_ACTIVE":
			return "Bu döneme ait bütçe planı aktif değil.";
		case "MONTH_CLOSE_UNCLASSIFIED_EXPENSES":
			return "Bu dönemde sınıflandırılmamış harcamalar var. Lütfen önce hareketleri kategorize edin.";
		case "MONTH_CLOSE_MIDAS_NOT_FOUND":
			return "Midas likidite hesabı bulunamadı. Lütfen Midas hesabınızı bağlayın.";
		case "MONTH_CLOSE_INSUFFICIENT_LIQUIDITY":
			return "Midas serbest bakiye kapanış aktarımı için yeterli değil.";
		case "MONTH_CLOSE_STALE_PROPOSAL":
			return "Kapanış verileri siz incelerken değişti. Güncel öneri yeniden yüklendi; lütfen tekrar kontrol edin.";
		case "MONTH_CLOSE_ALREADY_CLOSED":
			return "Bu dönem daha önce tamamlandı.";
		case "MONTH_CLOSE_IDEMPOTENCY_CONFLICT":
			return "Bu kapanış işlemi daha önce farklı bilgilerle gönderilmiş. Lütfen işlemi yenileyin.";
		case "MONTH_CLOSE_NOT_FOUND":
			return "Bu döneme ait tamamlanmış bir kapanış kaydı bulunamadı.";

		// Ledger
		case "LEDGER_ACCOUNT_CODE_CONFLICT":
			return "Bu kodla bir hesap zaten mevcut.";
		case "LEDGER_INVALID_INPUT":
			return "Girilen hesap bilgileri geçersiz.";
		default:
			return fallback && fallback.trim() !== ""
				? fallback
				: "Bir hata oluştu. Lütfen tekrar deneyin.";
	}
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

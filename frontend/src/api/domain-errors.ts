import { registerDomainErrorMessages } from "./errors";

export const DOMAIN_ERROR_MESSAGES: Record<string, string> = {
	PEOPLE_INVALID_INPUT:
		"Girilen bilgiler geçersiz. Lütfen alanları kontrol edin.",
	PEOPLE_LEDGER_ACCOUNT_INVALID:
		"Seçilen hesap geçerli değil veya bu işlem için uygun değil.",
	PEOPLE_NOT_FOUND: "Kişi kaydı bulunamadı.",
	PEOPLE_NOT_ACTIVE: "Bu kişi kaydı aktif değil veya arşivlenmiş.",
	PEOPLE_REVISION_CONFLICT:
		"Kişi bilgileri başka bir işlem tarafından güncellendi. Lütfen sayfayı yenileyip tekrar deneyin.",
	PEOPLE_OBLIGATION_NOT_FOUND: "Borç/alacak kaydı bulunamadı.",
	PEOPLE_OBLIGATION_NOT_ACTIVE:
		"Bu borç/alacak kaydı aktif değil veya kapatılmış.",
	PEOPLE_OBLIGATION_REVISION_CONFLICT:
		"Borç/alacak kaydı başka bir işlem tarafından güncellendi. Lütfen sayfayı yenileyip tekrar deneyin.",
	PEOPLE_OBLIGATION_SETTLEMENT_CONFLICT:
		"Bu borç/alacak için daha önce ödeme kaydı bulunduğu için bu değişiklik yapılamıyor.",
	PEOPLE_OBLIGATION_OVERSETTLEMENT:
		"Ödeme tutarı kalan borç/alacak tutarından fazla olamaz.",
	PEOPLE_OBLIGATION_SPLIT_MANAGED:
		"Bu alacak kart harcaması bölüşümünden oluşturuldu. Tutarı değiştirmek için ilgili ortak harcamayı düzenleyin.",
	PEOPLE_PERSON_HAS_OUTSTANDING_BALANCE:
		"Bu kişide açık borç/alacak bulunduğu için arşivlenemiyor.",
	PEOPLE_SETTLEMENT_NOT_FOUND: "Ödeme kaydı bulunamadı.",
	PEOPLE_SETTLEMENT_NOT_ACTIVE:
		"Bu ödeme kaydı aktif değil veya iptal edilmiş.",
	PEOPLE_IDEMPOTENCY_CONFLICT:
		"Bu işlem daha önce farklı bilgilerle gönderilmiş. Lütfen işlemi yenileyin.",
	PEOPLE_NO_OPEN_RECEIVABLES:
		"Bu kişinin tahsil edilecek açık alacağı bulunmuyor.",

	// Short-Term Goals
	SHORT_TERM_GOAL_INVALID_INPUT:
		"Girilen hedef bilgileri geçersiz. Lütfen alanları kontrol edin.",
	SHORT_TERM_GOAL_NOT_FOUND: "Kısa vadeli hedef bulunamadı.",
	SHORT_TERM_GOAL_NOT_ACTIVE: "Bu hedef aktif durumda değil.",
	SHORT_TERM_GOAL_NON_ZERO_BALANCE:
		"Bu hedefte ayrılmış para bulunduğu için işlem tamamlanamaz. Önce bakiyeyi serbest bırakın.",
	SHORT_TERM_GOAL_BALANCE_NOT_ZERO:
		"Bu hedefte ayrılmış para bulunduğu için işlem tamamlanamaz. Önce bakiyeyi serbest bırakın.",
	SHORT_TERM_GOAL_BUCKET_NOT_FOUND: "Hedefe ait Midas bütçe havuzu bulunamadı.",
	SHORT_TERM_GOAL_MIDAS_ACCOUNT_NOT_FOUND:
		"Midas likidite hesabı bulunamadı. Lütfen önce Midas hesabını bağlayın.",
	SHORT_TERM_GOAL_MAX_BUDGET_EXCEEDED:
		"Toplam hedef birikimi belirlenen azami bütçeyi aşamaz.",
	SHORT_TERM_GOAL_PRIORITY_COLLISION:
		"Hedef öncelik sıralamasında çakışma oluştu. Lütfen güncel listeyi inceleyip tekrar sıralayın.",
	SHORT_TERM_GOAL_PRIORITY_MISMATCH:
		"Hedef öncelik sıralamasında çakışma oluştu. Lütfen güncel listeyi inceleyip tekrar sıralayın.",
	SHORT_TERM_GOAL_PRIORITY_CONFLICT:
		"Hedef öncelik sıralamasında çakışma oluştu. Lütfen güncel listeyi inceleyip tekrar sıralayın.",
	SHORT_TERM_GOAL_REVISION_CONFLICT:
		"Hedef bilgileri başka bir işlem tarafından güncellendi. Lütfen sayfayı yenileyip tekrar deneyin.",
	SHORT_TERM_GOAL_INSUFFICIENT_FREE_BALANCE:
		"Midas serbest bakiyeniz bu fonlama için yetersiz.",
	SHORT_TERM_GOAL_INSUFFICIENT_BALANCE:
		"Hedef havuzunda çekilmek istenen tutarda bakiye bulunmuyor.",
	SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT:
		"Bu işlem daha önce farklı bilgilerle gönderilmiş. Lütfen işlemi yenileyin.",

	// Midas
	MIDAS_INVALID_INPUT: "Girilen Midas bilgileri geçersiz.",
	MIDAS_ACCOUNT_NOT_FOUND: "Midas likidite hesabı bulunamadı.",
	MIDAS_ACCOUNT_CONFLICT: "Bu kullanıcı için zaten bir Midas hesabı bağlı.",
	MIDAS_LEDGER_ACCOUNT_INVALID:
		"Seçilen kasa/banka hesabı Midas likidite hesabı için uygun değil.",
	MIDAS_BUCKET_NOT_FOUND: "İlgili Midas havuzu bulunamadı.",
	MIDAS_BUCKET_CONFLICT:
		"Bu isim veya koda sahip bir Midas havuzu zaten mevcut.",
	MIDAS_INSUFFICIENT_FREE_BALANCE:
		"Midas serbest / dağıtılmamış bakiyesi yetersiz.",
	MIDAS_INSUFFICIENT_BUCKET_BALANCE: "Havuz bakiyesi bu aktarım için yetersiz.",
	MIDAS_IDEMPOTENCY_CONFLICT:
		"Bu transfer daha önce farklı bilgilerle gönderilmiş. Lütfen işlemi yenileyin.",
	MIDAS_TRANSFER_NOT_FOUND: "Midas transfer kaydı bulunamadı.",
	MIDAS_TRANSFER_ALREADY_REVERSED:
		"Bu transfer kaydı daha önce tersine çevrilmiş.",
	MIDAS_BUCKET_INACTIVE: "Bu Midas havuzu aktif değil.",
	MIDAS_BUCKET_CAP_EXCEEDED: "Havuz için belirlenen azami limit aşılıyor.",
	MIDAS_LONG_TERM_BUCKET_RESTRICTED:
		"Uzun vadeli yatırım havuzuna genel transfer yapılamaz. Lütfen Uzun Vadeli Görevler akışını kullanın.",

	// Long-Term
	LONG_TERM_INVALID_INPUT: "Girilen uzun vadeli görev bilgileri geçersiz.",
	LONG_TERM_TASK_NOT_FOUND: "Uzun vadeli yatırım görevi bulunamadı.",
	LONG_TERM_TASK_NOT_PENDING: "Bu görev bekleme durumunda değil.",
	LONG_TERM_TASK_NOT_SENT: "Bu görev gönderildi durumunda değil.",
	LONG_TERM_TASK_CANCELLED:
		"Bu görev iptal edilmiş ve üzerinde işlem yapılamaz.",
	LONG_TERM_REVISION_CONFLICT:
		"Görev başka bir işlem tarafından güncellendi. Lütfen sayfayı yenileyip tekrar deneyin.",
	LONG_TERM_IDEMPOTENCY_CONFLICT:
		"Bu görev işlemi daha önce farklı bilgilerle gönderilmiş. Lütfen işlemi yenileyin.",
	LONG_TERM_INSUFFICIENT_UNALLOCATED:
		"Midas serbest bakiyesi bu görev tutarını karşılamak için yetersiz.",

	// Income (F8)
	INCOME_INVALID_INPUT:
		"Girilen gelir bilgileri geçersiz. Lütfen alanları kontrol edin.",
	INCOME_SOURCE_NOT_FOUND: "Gelir kaynağı bulunamadı.",
	INCOME_SOURCE_ARCHIVED:
		"Bu gelir kaynağı arşivlenmiş ve üzerinde işlem yapılamaz.",
	INCOME_SOURCE_CODE_CONFLICT:
		"Bu kaynak koduyla tanımlı bir gelir kaynağı zaten mevcut.",
	INCOME_LEDGER_ACCOUNT_INVALID:
		"Seçilen muhasebe hesabı gelir kaynağı için uygun değil.",
	INCOME_DESTINATION_ACCOUNT_INVALID:
		"Seçilen kasa/banka hesabı tahsilat için uygun değil.",
	INCOME_ENTITLEMENT_NOT_FOUND: "Beklenen gelir kaydı bulunamadı.",
	INCOME_ENTITLEMENT_PERIOD_CONFLICT:
		"Bu gelir kaynağı için bu döneme ait beklenen gelir zaten mevcut.",
	INCOME_ENTITLEMENT_REVISION_CONFLICT:
		"Beklenen gelir bilgileri başka bir işlem tarafından güncellendi. Lütfen sayfayı yenileyip tekrar deneyin.",
	INCOME_ENTITLEMENT_ALREADY_VOIDED: "Bu beklenen gelir zaten iptal edilmiş.",
	INCOME_RECEIPT_NOT_FOUND: "Gerçekleşen gelir tahsilat kaydı bulunamadı.",
	INCOME_RECEIPT_REVISION_CONFLICT:
		"Tahsilat bilgileri başka bir işlem tarafından güncellendi. Lütfen sayfayı yenileyip tekrar deneyin.",
	INCOME_RECEIPT_ALREADY_VOIDED: "Bu tahsilat kaydı zaten iptal edilmiş.",
	INCOME_SETTLEMENT_NOT_FOUND: "Henüz beklenen gelir eşleştirmesi yapılmadı.",
	INCOME_SETTLEMENT_CONFLICT:
		"Bu beklenen gelir bir tahsilatla eşleştirildiği için doğrudan iptal edilemiyor. Önce tahsilat eşleştirmesini düzeltin.",
	INCOME_SETTLEMENT_ALREADY_EXISTS:
		"Bu tahsilat için zaten bir eşleştirme kaydı mevcut.",
	INCOME_SETTLEMENT_REVISION_CONFLICT:
		"Eşleştirme bilgileri başka bir işlem tarafından güncellendi. Lütfen güncel durumu kontrol edin.",
	INCOME_IDEMPOTENCY_CONFLICT:
		"Bu işlem daha önce farklı bilgilerle gönderilmiş. Lütfen işlemi yenileyin.",

	// Month Close (F8)
	MONTH_CLOSE_INVALID_INPUT: "Dönem kapatma parametreleri geçersiz.",
	MONTH_CLOSE_PERIOD_NOT_ENDED:
		"Bu dönem henüz tamamlanmadığı için kapatılamaz.",
	MONTH_CLOSE_BUDGET_PLAN_NOT_FOUND:
		"Bu dönem için bütçe planı bulunamadı. Dönem kapatılamaz.",
	MONTH_CLOSE_BUDGET_PLAN_NOT_ACTIVE: "Bu döneme ait bütçe planı aktif değil.",
	MONTH_CLOSE_UNCLASSIFIED_EXPENSES:
		"Bu dönemde sınıflandırılmamış harcamalar var. Lütfen önce hareketleri kategorize edin.",
	MONTH_CLOSE_MIDAS_NOT_FOUND:
		"Midas likidite hesabı bulunamadı. Lütfen Midas hesabınızı bağlayın.",
	MONTH_CLOSE_INSUFFICIENT_LIQUIDITY:
		"Midas serbest bakiye kapanış aktarımı için yeterli değil.",
	MONTH_CLOSE_STALE_PROPOSAL:
		"Kapanış verileri siz incelerken değişti. Güncel öneri yeniden yüklendi; lütfen tekrar kontrol edin.",
	MONTH_CLOSE_ALREADY_CLOSED: "Bu dönem daha önce tamamlandı.",
	MONTH_CLOSE_IDEMPOTENCY_CONFLICT:
		"Bu kapanış işlemi daha önce farklı bilgilerle gönderilmiş. Lütfen işlemi yenileyin.",
	MONTH_CLOSE_NOT_FOUND:
		"Bu döneme ait tamamlanmış bir kapanış kaydı bulunamadı.",

	// Imports (F9)
	IMPORT_INVALID_INPUT: "İçe aktarma verileri veya parametreleri geçersiz.",
	IMPORT_BATCH_NOT_FOUND: "İçe aktarma grubu bulunamadı.",
	IMPORT_ROW_NOT_FOUND: "İçe aktarılan satır kaydı bulunamadı.",
	IMPORT_REVISION_CONFLICT:
		"Satır durumu başka bir işlem tarafından güncellendi. Lütfen güncel durumu kontrol edin.",
	IMPORT_IDEMPOTENCY_CONFLICT:
		"Bu işlem daha önce farklı bilgilerle gönderilmiş. Lütfen işlemi yenileyin.",
	IMPORT_NEEDS_REVIEW:
		"Bu satırın uygulanabilmesi için kart veya gelir eşleştirmelerinin tamamlanması gerekiyor.",
	IMPORT_POSSIBLE_DUPLICATE:
		"Bu satır mevcut bir kayıtla benzer görünüyor. Lütfen inceleyip karar verin.",
	IMPORT_EXACT_DUPLICATE:
		"Bu kayıt daha önce içe aktarılmış aynı işlemle eşleşiyor.",
	IMPORT_UNSUPPORTED_RECORD:
		"Bu işlem türü henüz sistem tarafından desteklenmiyor.",
	IMPORT_TARGET_NOT_FOUND:
		"Eşleştirilmek istenen hedef işlem kaydı bulunamadı.",
	IMPORT_TARGET_MISMATCH: "Seçilen hedef işlem bilgileri bu satırla uyuşmuyor.",
	IMPORT_MISSING_CARD_MAPPING:
		"Bu kart harcaması için geçerli bir kredi kartı seçilmelidir.",
	IMPORT_MISSING_INCOME_MAPPING:
		"Bu gelir tahsilatı için gelir kaynağı ve tahsilat hesabı seçilmelidir.",
	IMPORT_MISSING_EXPENSE_MAPPING:
		"Bu harcama için gerekli kategori veya hesap eşleştirmesi eksik.",
	IMPORT_INVALID_STATE: "Satırın mevcut durumu bu işlem için uygun değil.",

	// Notifications (F9)
	NOTIFICATION_INVALID_INPUT:
		"Bildirim parametreleri veya abonelik bilgileri geçersiz.",
	NOTIFICATION_SUBSCRIPTION_NOT_FOUND: "Bildirim aboneliği bulunamadı.",
	NOTIFICATION_SUBSCRIPTION_DISABLED:
		"Bu bildirim aboneliği zaten devre dışı bırakılmış.",
	NOTIFICATION_REVISION_CONFLICT:
		"Abonelik durumu güncellendi. Lütfen sayfayı yenileyip tekrar deneyin.",
	NOTIFICATION_IDEMPOTENCY_CONFLICT:
		"Bu abonelik işlemi daha önce farklı bilgilerle gönderilmiş. Lütfen işlemi yenileyin.",
	NOTIFICATION_EVENT_NOT_FOUND: "Bildirim kaydı bulunamadı.",
	NOTIFICATION_PUSH_CONFIG_INVALID:
		"Bildirim servisiyle iletişim kurulamadı. Lütfen daha sonra tekrar deneyin.",
	NOTIFICATION_PUSH_DELIVERY_FAILED:
		"Bildirim servisiyle iletişim kurulamadı. Lütfen daha sonra tekrar deneyin.",

	// Ledger
	LEDGER_ACCOUNT_CODE_CONFLICT: "Bu kodla bir hesap zaten mevcut.",
	LEDGER_INVALID_INPUT: "Girilen hesap bilgileri geçersiz.",
};

registerDomainErrorMessages(DOMAIN_ERROR_MESSAGES);

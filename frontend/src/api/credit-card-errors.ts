/**
 * Natural Turkish Error Mapping for Credit Cards OS
 *
 * Implements Section 62:
 *   Map at minimum:
 *   CREDIT_CARD_INVALID_INPUT, CREDIT_CARD_LEDGER_ACCOUNT_INVALID,
 *   CREDIT_CARD_NOT_FOUND, CREDIT_CARD_STATEMENT_NOT_FOUND,
 *   CREDIT_CARD_PURCHASE_NOT_FOUND, CREDIT_CARD_NOT_ACTIVE,
 *   CREDIT_CARD_CONFLICT, CREDIT_CARD_REVISION_CONFLICT,
 *   CREDIT_CARD_STATEMENT_PERIOD_CONFLICT, CREDIT_CARD_STATEMENT_NOT_OPEN,
 *   CREDIT_CARD_STATEMENT_REVISION_CONFLICT, CREDIT_CARD_STATEMENT_ALREADY_PAID,
 *   CREDIT_CARD_STATEMENT_NOT_PAID, CREDIT_CARD_INSUFFICIENT_MIDAS_LIQUIDITY,
 *   CREDIT_CARD_RESERVE_CONFLICT, CREDIT_CARD_LIABILITY_SHORTFALL,
 *   CREDIT_CARD_PAYMENT_CONFLICT, CREDIT_CARD_IDEMPOTENCY_CONFLICT,
 *   CREDIT_CARD_PURCHASE_NOT_ACTIVE, CREDIT_CARD_CANNOT_ARCHIVE_WITH_LIABILITY,
 *   CREDIT_CARD_SPLIT_NOT_FOUND, CREDIT_CARD_SPLIT_NOT_ACTIVE,
 *   CREDIT_CARD_SPLIT_REVISION_CONFLICT, CREDIT_CARD_SPLIT_IDEMPOTENCY_CONFLICT,
 *   CREDIT_CARD_SPLIT_CONFLICT
 */

import { ApiError } from "./errors";

export function mapCreditCardError(err: unknown): string {
	const code =
		err instanceof ApiError
			? err.code
			: err && typeof err === "object" && "code" in err
				? String((err as { code: unknown }).code)
				: undefined;

	const message =
		err instanceof Error
			? err.message
			: err && typeof err === "object" && "message" in err
				? String((err as { message: unknown }).message)
				: undefined;

	if (code) {
		switch (code) {
			case "CREDIT_CARD_INVALID_INPUT":
				return "Girdiğiniz kart, ekstre veya harcama bilgilerini kontrol edin.";
			case "CREDIT_CARD_LEDGER_ACCOUNT_INVALID":
				return "Seçilen muhasebe hesabı bu işlem için uygun değil.";
			case "CREDIT_CARD_NOT_FOUND":
				return "Kredi kartı bulunamadı.";
			case "CREDIT_CARD_STATEMENT_NOT_FOUND":
				return "Ekstre bulunamadı.";
			case "CREDIT_CARD_PURCHASE_NOT_FOUND":
				return "Kart harcaması bulunamadı.";
			case "CREDIT_CARD_NOT_ACTIVE":
				return "Bu kart aktif değil.";
			case "CREDIT_CARD_CONFLICT":
				return "Bu kart kodu zaten kullanımda veya çakışma var.";
			case "CREDIT_CARD_REVISION_CONFLICT":
				return "Kart bilgileri başka bir işlemle güncellenmiş. Lütfen sayfayı yenileyip tekrar deneyin.";
			case "CREDIT_CARD_CANNOT_ARCHIVE_WITH_LIABILITY":
				return "Bu kartın açık yükümlülüğü bulunduğu için arşivlenemiyor.";
			case "CREDIT_CARD_STATEMENT_PERIOD_CONFLICT":
				return "Bu dönem için zaten bir ekstre kaydı mevcut.";
			case "CREDIT_CARD_STATEMENT_NOT_OPEN":
				return "Bu ekstre açık durumda değil.";
			case "CREDIT_CARD_STATEMENT_REVISION_CONFLICT":
				return "Ekstre bilgileri başka bir işlemle güncellenmiş. Lütfen sayfayı yenileyip tekrar deneyin.";
			case "CREDIT_CARD_STATEMENT_ALREADY_PAID":
				return "Bu ekstre zaten ödenmiş.";
			case "CREDIT_CARD_STATEMENT_NOT_PAID":
				return "Bu ekstre henüz ödenmemiş.";
			case "CREDIT_CARD_INSUFFICIENT_MIDAS_LIQUIDITY":
				return "Midas likidite bakiyesi yetersiz.";
			case "CREDIT_CARD_RESERVE_CONFLICT":
				return "Kart rezervi tahsisinde çakışma oluştu.";
			case "CREDIT_CARD_LIABILITY_SHORTFALL":
				return "Kart yükümlülüğü ekstre tutarını karşılamıyor.";
			case "CREDIT_CARD_PAYMENT_CONFLICT":
				return "Ödeme işlemi sırasında bir çakışma oluştu.";
			case "CREDIT_CARD_IDEMPOTENCY_CONFLICT":
				return "Bu işlem daha önce farklı bilgilerle gönderilmiş. Lütfen formu gözden geçirin.";
			case "CREDIT_CARD_PURCHASE_NOT_ACTIVE":
				return "Kart harcaması aktif değil.";
			case "CREDIT_CARD_SPLIT_NOT_FOUND":
				return "Ortak harcama paylaşımı bulunamadı.";
			case "CREDIT_CARD_SPLIT_NOT_ACTIVE":
				return "Ortak harcama paylaşımı aktif değil.";
			case "CREDIT_CARD_SPLIT_REVISION_CONFLICT":
				return "Paylaşım bilgileri başka bir işlemle güncellenmiş. Lütfen güncel bilgileri inceleyin.";
			case "CREDIT_CARD_SPLIT_IDEMPOTENCY_CONFLICT":
				return "Paylaşım işlemi daha önce farklı bilgilerle gönderilmiş.";
			case "CREDIT_CARD_SPLIT_CONFLICT":
				return "Bu ortak harcamanın bazı paylarında tahsilat kaydı bulunduğu için değişiklik bu şekilde yapılamıyor.";
			case "PEOPLE_NOT_FOUND":
				return "Seçilen kişi bulunamadı.";
			case "MIDAS_ACCOUNT_NOT_FOUND":
				return "Midas likidite hesabı bulunamadı.";
			case "UNAUTHENTICATED":
				return "Oturum süresi doldu. Lütfen tekrar giriş yapın.";
			case "NETWORK_ERROR":
				return "İşlemin tamamlanıp tamamlanmadığı doğrulanamadı.";
			default:
				return message && !message.includes("status 500")
					? message
					: "İşlem sırasında bir hata oluştu. Lütfen tekrar deneyin.";
		}
	}
	return message && !message.includes("status 500")
		? message
		: "Beklenmeyen bir hata oluştu.";
}

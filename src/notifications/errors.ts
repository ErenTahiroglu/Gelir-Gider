export const NOTIFICATION_ERROR_CODES = [
	"NOTIFICATION_INVALID_INPUT",
	"NOTIFICATION_SUBSCRIPTION_NOT_FOUND",
	"NOTIFICATION_SUBSCRIPTION_DISABLED",
	"NOTIFICATION_REVISION_CONFLICT",
	"NOTIFICATION_IDEMPOTENCY_CONFLICT",
	"NOTIFICATION_EVENT_NOT_FOUND",
	"NOTIFICATION_INVALID_STATE",
	"NOTIFICATION_PUSH_CONFIG_INVALID",
	"NOTIFICATION_PUSH_DELIVERY_FAILED",
] as const;

export type NotificationErrorCode = (typeof NOTIFICATION_ERROR_CODES)[number];

export class NotificationError extends Error {
	readonly code: NotificationErrorCode;

	constructor(code: NotificationErrorCode, message: string) {
		super(message);
		this.name = "NotificationError";
		this.code = code;
		Object.setPrototypeOf(this, NotificationError.prototype);
	}
}

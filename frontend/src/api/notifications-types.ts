/**
 * Notification Domain Types (Phase F9).
 * Exact match with backend notifications schema and HTTP contract.
 */

export type NotificationEventType =
	| "CREDIT_CARD_DUE"
	| "CREDIT_CARD_DUE_SOON"
	| "BUDGET_THRESHOLD"
	| "NO_SPEND_CHECK";

export interface NotificationEventDto {
	id: string;
	userId: string;
	notificationType: NotificationEventType;
	subjectId: string;
	scheduledLocalDate: string;
	scheduledFor: string;
	createdAt: string;
}

export interface NotificationEventsListResponse {
	items: NotificationEventDto[];
	nextCursor: string | null;
}

export type PushSubscriptionStatus = "ACTIVE" | "DISABLED";

export interface PushSubscriptionDto {
	subscriptionId: string;
	userId: string;
	status: PushSubscriptionStatus;
	revisionNo: number;
	expirationTime: string | null;
	userAgent: string | null;
	createdAt: string;
}

export interface PushSubscriptionsListResponse {
	items: PushSubscriptionDto[];
	nextCursor: string | null;
}

export interface RegisterPushSubscriptionRequest {
	endpoint: string;
	p256dh: string;
	auth: string;
	expirationTime?: string | null;
	userAgent?: string | null;
	occurredAt: string;
}

export interface RegisterPushSubscriptionResponse extends PushSubscriptionDto {
	idempotentReplay: boolean;
}

export interface DisablePushSubscriptionRequest {
	disableReason?: string;
	occurredAt: string;
}

export interface DisablePushSubscriptionResponse extends PushSubscriptionDto {
	idempotentReplay: boolean;
}

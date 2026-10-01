import {
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import {
	AlertCircle,
	AlertTriangle,
	Bell,
	BellOff,
	CheckCircle,
	Laptop,
	RefreshCw,
	ShieldCheck,
	Smartphone,
	Trash2,
	XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { getApiErrorMessage } from "../../api/errors";
import {
	disablePushSubscription,
	getPushSubscriptions,
	registerPushSubscription,
} from "../../api/notifications-api";
import { formatIstanbulDateTime } from "../../lib/istanbul-date";
import {
	getOrRegisterPushServiceWorker,
	getStoredPushSubscriptionId,
	isPushSupported,
	removeStoredPushSubscriptionId,
	serializeBrowserPushSubscription,
	setStoredPushSubscriptionId,
	urlBase64ToUint8Array,
} from "../../lib/web-push";

interface FrozenRegisterAttempt {
	idempotencyKey: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	expirationTime: string | null;
	userAgent: string;
	occurredAt: string;
}

interface FrozenDisableAttempt {
	idempotencyKey: string;
	subscriptionId: string;
	occurredAt: string;
	disableReason?: string;
}

export function PushSettings() {
	const queryClient = useQueryClient();
	const vapidPublicKey = import.meta.env.VITE_WEB_PUSH_VAPID_PUBLIC_KEY;
	const isSupported = isPushSupported();

	const [permissionState, setPermissionState] = useState<
		NotificationPermission | "unsupported"
	>(isSupported ? Notification.permission : "unsupported");
	const [localSubscription, setLocalSubscription] =
		useState<PushSubscription | null>(null);
	const [checkingLocalSub, setCheckingLocalSub] = useState(true);

	const [frozenRegister, setFrozenRegister] =
		useState<FrozenRegisterAttempt | null>(null);
	const [frozenDisable, setFrozenDisable] =
		useState<FrozenDisableAttempt | null>(null);
	const [statusMessage, setStatusMessage] = useState<{
		type: "success" | "error" | "warning";
		text: string;
	} | null>(null);

	// Load local subscription status on mount
	useEffect(() => {
		if (!isSupported) {
			setCheckingLocalSub(false);
			return;
		}

		let mounted = true;
		async function checkSub() {
			try {
				const reg = await navigator.serviceWorker.getRegistration("/push/");
				if (reg && mounted) {
					const sub = await reg.pushManager.getSubscription();
					if (mounted) setLocalSubscription(sub);
				}
			} catch (err) {
				console.error("Error inspecting local push subscription:", err);
			} finally {
				if (mounted) setCheckingLocalSub(false);
			}
		}

		void checkSub();
		return () => {
			mounted = false;
		};
	}, [isSupported]);

	// Device subscriptions query
	const subscriptionsQuery = useInfiniteQuery({
		queryKey: ["push-subscriptions"],
		queryFn: ({ pageParam }) =>
			getPushSubscriptions({
				limit: 50,
				...(pageParam ? { after: pageParam } : {}),
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
	});

	const allSubscriptions =
		subscriptionsQuery.data?.pages.flatMap((page) => page?.items ?? []) ?? [];

	// Register Mutation
	const registerMutation = useMutation({
		mutationFn: async (attempt: FrozenRegisterAttempt) => {
			return registerPushSubscription(
				{
					endpoint: attempt.endpoint,
					p256dh: attempt.p256dh,
					auth: attempt.auth,
					expirationTime: attempt.expirationTime,
					userAgent: attempt.userAgent,
					occurredAt: attempt.occurredAt,
				},
				attempt.idempotencyKey,
			);
		},
		retry: false,
		onSuccess: (res) => {
			setStoredPushSubscriptionId(res.subscriptionId);
			setFrozenRegister(null);
			setStatusMessage({
				type: "success",
				text: "Web Push bildirimleri bu cihaz için başarıyla etkinleştirildi.",
			});
			void queryClient.invalidateQueries({ queryKey: ["push-subscriptions"] });
		},
		onError: (err) => {
			setStatusMessage({
				type: "error",
				text: `Bildirim aboneliğinin sunucuya kaydedilip kaydedilmediği doğrulanamadı: ${getApiErrorMessage(err)}`,
			});
		},
	});

	// Disable Mutation
	const disableMutation = useMutation({
		mutationFn: async (attempt: FrozenDisableAttempt) => {
			return disablePushSubscription(
				attempt.subscriptionId,
				{
					occurredAt: attempt.occurredAt,
					disableReason:
						attempt.disableReason ?? "Kullanıcı tarayıcıdan kapattı",
				},
				attempt.idempotencyKey,
			);
		},
		retry: false,
		onSuccess: async (_res, attempt) => {
			setFrozenDisable(null);
			void queryClient.invalidateQueries({ queryKey: ["push-subscriptions"] });

			// Backend confirmed success -> now perform local browser unsubscribe
			const storedId = getStoredPushSubscriptionId();
			if (storedId === attempt.subscriptionId && localSubscription) {
				try {
					await localSubscription.unsubscribe();
					setLocalSubscription(null);
					removeStoredPushSubscriptionId();
					setStatusMessage({
						type: "success",
						text: "Bildirim aboneliği başarıyla devre dışı bırakıldı.",
					});
				} catch (unsubErr) {
					console.error("Local unsubscribe error:", unsubErr);
					setStatusMessage({
						type: "warning",
						text: "Sunucu bildirimi kapatıldı ancak tarayıcı aboneliği temizlenemedi.",
					});
				}
			} else {
				setStatusMessage({
					type: "success",
					text: "Bildirim aboneliği başarıyla devre dışı bırakıldı.",
				});
			}
		},
		onError: (err) => {
			setStatusMessage({
				type: "error",
				text: `Bildirim aboneliğinin devre dışı bırakıldığı doğrulanamadı: ${getApiErrorMessage(err)}`,
			});
		},
	});

	const handleEnablePush = async () => {
		if (!isSupported) return;
		if (!vapidPublicKey) {
			setStatusMessage({
				type: "error",
				text: "Push bildirimleri bu ortamda yapılandırılmamış.",
			});
			return;
		}

		setStatusMessage(null);

		try {
			// Explicit user action permission request
			let perm = Notification.permission;
			if (perm === "default") {
				perm = await Notification.requestPermission();
				setPermissionState(perm);
			}

			if (perm !== "granted") {
				setStatusMessage({
					type: "warning",
					text: "Bildirim izni verilmediği için push bildirimleri açılamıyor.",
				});
				return;
			}

			const reg = await getOrRegisterPushServiceWorker();
			let sub = await reg.pushManager.getSubscription();

			if (!sub) {
				const appServerKey = urlBase64ToUint8Array(vapidPublicKey);
				sub = await reg.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: appServerKey as unknown as BufferSource,
				});
			}

			setLocalSubscription(sub);
			const serialized = serializeBrowserPushSubscription(sub);

			const attempt: FrozenRegisterAttempt = {
				idempotencyKey: crypto.randomUUID(),
				endpoint: serialized.endpoint,
				p256dh: serialized.p256dh,
				auth: serialized.auth,
				expirationTime: serialized.expirationTime,
				userAgent: navigator.userAgent,
				occurredAt: new Date().toISOString(),
			};

			setFrozenRegister(attempt);
			registerMutation.mutate(attempt);
		} catch (err) {
			console.error("Enable push error:", err);
			setStatusMessage({
				type: "error",
				text: "Bildirim aboneliği oluşturulurken bir hata meydana geldi.",
			});
		}
	};

	const handleDisableCurrentDevice = async () => {
		const storedId = getStoredPushSubscriptionId();
		if (!storedId) {
			// If not stored in local storage, attempt to match against server active list
			const activeMatch = allSubscriptions.find(
				(s) => s.status === "ACTIVE" && s.userAgent === navigator.userAgent,
			);
			if (!activeMatch) {
				// No server match known, just clean up local subscription if any
				if (localSubscription) {
					await localSubscription.unsubscribe();
					setLocalSubscription(null);
				}
				setStatusMessage({
					type: "success",
					text: "Yerel tarayıcı aboneliği temizlendi.",
				});
				return;
			}
			initiateDisable(activeMatch.subscriptionId);
			return;
		}

		initiateDisable(storedId);
	};

	const initiateDisable = (subscriptionId: string) => {
		setStatusMessage(null);
		const attempt: FrozenDisableAttempt = {
			idempotencyKey: crypto.randomUUID(),
			subscriptionId,
			occurredAt: new Date().toISOString(),
			disableReason: "Kullanıcı tarayıcıdan kapattı",
		};
		setFrozenDisable(attempt);
		disableMutation.mutate(attempt);
	};

	const handleCleanupLocalSubscription = async () => {
		if (localSubscription) {
			try {
				await localSubscription.unsubscribe();
				setLocalSubscription(null);
				removeStoredPushSubscriptionId();
				setStatusMessage({
					type: "success",
					text: "Tarayıcı aboneliği başarıyla temizlendi.",
				});
			} catch (_err) {
				setStatusMessage({
					type: "error",
					text: "Tarayıcı aboneliği temizlenemedi.",
				});
			}
		}
	};

	const isCurrentlyActive =
		!!localSubscription && permissionState === "granted";

	return (
		<div className="push-settings-section" data-testid="push-settings-section">
			<div className="section-header">
				<div>
					<h2 className="section-title">Web Push Bildirimleri</h2>
					<span className="section-subtitle">
						Ödeme günleri ve bütçe eşikleri için anlık tarayıcı bildirimleri
					</span>
				</div>
			</div>

			{/* Status Feedback */}
			{statusMessage && (
				<div
					className={`alert-banner alert-${statusMessage.type}`}
					role="alert"
					data-testid="push-status-alert"
				>
					{statusMessage.type === "success" && (
						<CheckCircle size={18} aria-hidden="true" />
					)}
					{statusMessage.type === "error" && (
						<AlertCircle size={18} aria-hidden="true" />
					)}
					{statusMessage.type === "warning" && (
						<AlertTriangle size={18} aria-hidden="true" />
					)}
					<span>{statusMessage.text}</span>
				</div>
			)}

			{/* Frozen Retry Actions */}
			{frozenRegister && registerMutation.isError && (
				<div
					className="uncertain-retry-card card"
					data-testid="register-retry-box"
				>
					<AlertTriangle
						size={20}
						className="text-warning"
						aria-hidden="true"
					/>
					<div className="retry-content">
						<strong>Abonelik Durumu Doğrulanamadı</strong>
						<p>
							Bildirim aboneliğinin sunucuya kaydedilip kaydedilmediği
							doğrulanamadı.
						</p>
						<button
							type="button"
							className="btn btn-primary btn-sm"
							onClick={() => registerMutation.mutate(frozenRegister)}
							disabled={registerMutation.isPending}
							data-testid="btn-retry-register"
						>
							<RefreshCw size={14} aria-hidden="true" />
							Aynı Bilgilerle Tekrar Dene
						</button>
					</div>
				</div>
			)}

			{frozenDisable && disableMutation.isError && (
				<div
					className="uncertain-retry-card card"
					data-testid="disable-retry-box"
				>
					<AlertTriangle
						size={20}
						className="text-warning"
						aria-hidden="true"
					/>
					<div className="retry-content">
						<strong>Kapatma Durumu Doğrulanamadı</strong>
						<p>
							Bildirim aboneliğinin sunucuda kapatılıp kapatılmadığı
							doğrulanamadı.
						</p>
						<button
							type="button"
							className="btn btn-danger btn-sm"
							onClick={() => disableMutation.mutate(frozenDisable)}
							disabled={disableMutation.isPending}
							data-testid="btn-retry-disable"
						>
							<RefreshCw size={14} aria-hidden="true" />
							Aynı İstekle Tekrar Dene
						</button>
					</div>
				</div>
			)}

			{/* Browser Push Status Card */}
			<div className="card push-status-card" data-testid="browser-push-card">
				<div className="push-status-info">
					<div className="status-icon-wrapper">
						{!isSupported ? (
							<XCircle size={28} className="text-muted" aria-hidden="true" />
						) : permissionState === "denied" ? (
							<BellOff size={28} className="text-danger" aria-hidden="true" />
						) : isCurrentlyActive ? (
							<ShieldCheck
								size={28}
								className="text-success"
								aria-hidden="true"
							/>
						) : (
							<Bell size={28} className="text-muted" aria-hidden="true" />
						)}
					</div>

					<div className="status-text-wrapper">
						<h3 className="card-heading">Bu Tarayıcıda Bildirimler</h3>
						<p className="card-subtext">
							{!isSupported
								? "Bu tarayıcı Web Push bildirimlerini desteklemiyor."
								: !vapidPublicKey
									? "Push bildirimleri bu ortamda yapılandırılmamış."
									: permissionState === "denied"
										? "Bildirim izni engellenmiş. Tarayıcı ayarlarından bildirimlere izin vermeniz gerekiyor."
										: isCurrentlyActive
											? "Bildirimler açık. Ödeme hatırlatmaları ve limit uyarıları bu cihaza gönderilecek."
											: "Bildirimler kapalı. İstediğiniz zaman etkinleştirebilirsiniz."}
						</p>
					</div>
				</div>

				<div className="push-status-actions">
					{isSupported && vapidPublicKey && permissionState !== "denied" && (
						<>
							{isCurrentlyActive ? (
								<button
									type="button"
									className="btn btn-outline-danger"
									onClick={handleDisableCurrentDevice}
									disabled={disableMutation.isPending || checkingLocalSub}
									data-testid="btn-disable-push"
								>
									<BellOff size={16} aria-hidden="true" />
									{disableMutation.isPending
										? "Kapatılıyor..."
										: "Bildirimleri Kapat"}
								</button>
							) : (
								<button
									type="button"
									className="btn btn-primary"
									onClick={handleEnablePush}
									disabled={registerMutation.isPending || checkingLocalSub}
									data-testid="btn-enable-push"
								>
									<Bell size={16} aria-hidden="true" />
									{registerMutation.isPending
										? "Açılıyor..."
										: "Bildirimleri Aç"}
								</button>
							)}
						</>
					)}

					{statusMessage?.type === "warning" && localSubscription && (
						<button
							type="button"
							className="btn btn-secondary btn-sm"
							onClick={handleCleanupLocalSubscription}
							data-testid="btn-cleanup-local-sub"
						>
							Yerel Aboneliği Temizle
						</button>
					)}
				</div>
			</div>

			{/* Registered Devices List */}
			<div className="devices-section">
				<h3 className="sub-section-title">Kayıtlı Cihazlar</h3>

				{subscriptionsQuery.isLoading ? (
					<div className="loading-state" data-testid="subscriptions-loading">
						Cihazlar yükleniyor...
					</div>
				) : allSubscriptions.length === 0 ? (
					<div
						className="empty-state card"
						data-testid="empty-subscriptions-message"
					>
						<p>Kayıtlı bildirim cihazı bulunmuyor.</p>
					</div>
				) : (
					<div className="subscriptions-list" data-testid="subscriptions-list">
						{allSubscriptions.map((sub) => {
							const isActive = sub.status === "ACTIVE";
							const isCurrentDevice =
								sub.subscriptionId === getStoredPushSubscriptionId() ||
								(isActive && sub.userAgent === navigator.userAgent);

							return (
								<div
									key={sub.subscriptionId}
									className={`subscription-item card ${isActive ? "active-device" : "disabled-device"}`}
									data-testid={`subscription-item-${sub.subscriptionId}`}
								>
									<div className="sub-device-icon">
										{sub.userAgent &&
										/mobile|android|iphone/i.test(sub.userAgent) ? (
											<Smartphone size={20} aria-hidden="true" />
										) : (
											<Laptop size={20} aria-hidden="true" />
										)}
									</div>

									<div className="sub-device-details">
										<div className="sub-device-header">
											<span className="device-name">
												{sub.userAgent
													? sub.userAgent.split(" ").slice(0, 4).join(" ")
													: "Bilinmeyen Cihaz"}
											</span>
											{isCurrentDevice && (
												<span className="badge badge-primary">Bu Cihaz</span>
											)}
											<span
												className={`status-pill ${isActive ? "status-ready" : "status-skipped"}`}
												data-testid={`sub-status-${sub.subscriptionId}`}
											>
												{isActive ? "AÇIK" : "DEVRE DIŞI"}
											</span>
										</div>

										<span className="sub-device-date">
											Kayıt: {formatIstanbulDateTime(sub.createdAt)}
										</span>
									</div>

									<div className="sub-device-actions">
										{isActive && (
											<button
												type="button"
												className="btn btn-icon btn-ghost btn-sm text-danger"
												onClick={() => initiateDisable(sub.subscriptionId)}
												disabled={disableMutation.isPending}
												title="Bu cihazı devre dışı bırak"
												aria-label="Bu cihazı devre dışı bırak"
												data-testid={`btn-disable-sub-${sub.subscriptionId}`}
											>
												<Trash2 size={16} aria-hidden="true" />
											</button>
										)}
									</div>
								</div>
							);
						})}

						{subscriptionsQuery.hasNextPage && (
							<div className="pagination-actions">
								<button
									type="button"
									className="btn btn-secondary"
									onClick={() => void subscriptionsQuery.fetchNextPage()}
									disabled={subscriptionsQuery.isFetchingNextPage}
									data-testid="btn-load-more-subscriptions"
								>
									{subscriptionsQuery.isFetchingNextPage
										? "Yükleniyor..."
										: "Daha Fazla Cihaz Yükle"}
								</button>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

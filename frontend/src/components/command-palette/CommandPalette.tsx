import { useNavigate } from "@tanstack/react-router";
import {
	Bell,
	Calendar,
	CreditCard,
	DollarSign,
	FileSpreadsheet,
	Home,
	Lock,
	PieChart,
	Search,
	Sliders,
	Target,
	TrendingUp,
	Users,
	Wallet,
} from "lucide-react";
import type React from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useAuth } from "../../auth/auth-context";
import { useQuickEntry } from "../../context/QuickEntryContext";

export interface CommandItem {
	id: string;
	title: string;
	category: string;
	icon: React.ReactNode;
	keywords?: string[];
	action: () => void;
}

export interface CommandPaletteProps {
	isOpen: boolean;
	onClose: () => void;
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
	const navigate = useNavigate();
	const { openQuickEntry } = useQuickEntry();
	const { lockNow } = useAuth();
	const [query, setQuery] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);

	const searchInputId = useId();
	const dialogRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const previousActiveElementRef = useRef<HTMLElement | null>(null);

	// Define all minimal V1 commands
	const commands: CommandItem[] = useMemo(
		() => [
			{
				id: "home",
				title: "Ana Sayfa",
				category: "Gezinme",
				icon: <Home size={18} aria-hidden="true" />,
				keywords: ["dashboard", "özet", "ana sayfa"],
				action: () => void navigate({ to: "/" }),
			},
			{
				id: "transactions",
				title: "Hareketler",
				category: "Gezinme",
				icon: <DollarSign size={18} aria-hidden="true" />,
				keywords: ["işlemler", "harcamalar", "zaman tüneli", "timeline"],
				action: () => void navigate({ to: "/transactions" }),
			},
			{
				id: "cards",
				title: "Kredi Kartları",
				category: "Gezinme",
				icon: <CreditCard size={18} aria-hidden="true" />,
				keywords: ["kartlar", "ekstre", "kredi kartı"],
				action: () => void navigate({ to: "/cards" }),
			},
			{
				id: "income",
				title: "Gelirler",
				category: "Gezinme",
				icon: <Wallet size={18} aria-hidden="true" />,
				keywords: ["maaş", "tahsilat", "gelir kaynakları"],
				action: () => void navigate({ to: "/income" }),
			},
			{
				id: "people",
				title: "Kişiler",
				category: "Gezinme",
				icon: <Users size={18} aria-hidden="true" />,
				keywords: ["borç", "alacak", "arkadaşlar", "ortak harcama"],
				action: () => void navigate({ to: "/people" }),
			},
			{
				id: "midas",
				title: "Likidite",
				category: "Gezinme",
				icon: <PieChart size={18} aria-hidden="true" />,
				keywords: ["midas", "nemalandırma", "rezerv", "serbest bakiye"],
				action: () => void navigate({ to: "/midas" }),
			},
			{
				id: "goals",
				title: "Hedefler",
				category: "Gezinme",
				icon: <Target size={18} aria-hidden="true" />,
				keywords: ["birikim", "kısa vadeli", "tasarruf"],
				action: () => void navigate({ to: "/goals" }),
			},
			{
				id: "long-term",
				title: "Uzun Vadeli",
				category: "Gezinme",
				icon: <TrendingUp size={18} aria-hidden="true" />,
				keywords: ["yatırım", "görevler", "hisse", "fon"],
				action: () => void navigate({ to: "/long-term" }),
			},
			{
				id: "month-close",
				title: "Ayı Tamamla",
				category: "Gezinme",
				icon: <Calendar size={18} aria-hidden="true" />,
				keywords: ["kapanış", "dönem sonu", "ay sonu", "mutabakat"],
				action: () => void navigate({ to: "/month-close" }),
			},
			{
				id: "imports",
				title: "İçe Aktar",
				category: "Gezinme",
				icon: <FileSpreadsheet size={18} aria-hidden="true" />,
				keywords: ["csv", "ekstre yükle", "dosya aktar"],
				action: () => void navigate({ to: "/imports" }),
			},
			{
				id: "notifications",
				title: "Bildirimler",
				category: "Gezinme",
				icon: <Bell size={18} aria-hidden="true" />,
				keywords: ["uyarılar", "hatırlatıcılar", "web push"],
				action: () => void navigate({ to: "/notifications" }),
			},
			{
				id: "quick-entry",
				title: "Hızlı Kayıt",
				category: "Eylemler",
				icon: <Sliders size={18} aria-hidden="true" />,
				keywords: ["yeni işlem", "hızlı harcama", "şablon"],
				action: () => openQuickEntry(),
			},
			{
				id: "lock-app",
				title: "Uygulamayı Kilitle",
				category: "Eylemler",
				icon: <Lock size={18} aria-hidden="true" />,
				keywords: ["kilit", "çıkış", "güvenlik", "oturum kapat"],
				action: () => lockNow(),
			},
		],
		[navigate, openQuickEntry, lockNow],
	);

	// Filter commands based on search query
	const filteredCommands = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		if (!normalized) return commands;
		return commands.filter((cmd) => {
			if (cmd.title.toLowerCase().includes(normalized)) return true;
			if (cmd.category.toLowerCase().includes(normalized)) return true;
			if (cmd.keywords?.some((kw) => kw.toLowerCase().includes(normalized)))
				return true;
			return false;
		});
	}, [commands, query]);

	// Reset selected index on filter change
	useEffect(() => {
		setSelectedIndex(0);
	}, []);

	// Save and restore previous active element
	useEffect(() => {
		if (isOpen) {
			previousActiveElementRef.current =
				document.activeElement as HTMLElement | null;
			setQuery("");
			setSelectedIndex(0);
			// Focus input on next microtask
			setTimeout(() => {
				inputRef.current?.focus();
			}, 10);
		} else if (previousActiveElementRef.current) {
			previousActiveElementRef.current.focus?.();
			previousActiveElementRef.current = null;
		}
	}, [isOpen]);

	// Keyboard navigation & Focus trap
	useEffect(() => {
		if (!isOpen) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
				return;
			}

			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((prev) =>
					filteredCommands.length > 0
						? (prev + 1) % filteredCommands.length
						: 0,
				);
				return;
			}

			if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((prev) =>
					filteredCommands.length > 0
						? (prev - 1 + filteredCommands.length) % filteredCommands.length
						: 0,
				);
				return;
			}

			if (e.key === "Enter") {
				e.preventDefault();
				const targetCmd = filteredCommands[selectedIndex];
				if (targetCmd) {
					onClose();
					targetCmd.action();
				}
				return;
			}

			// Focus trap (Tab / Shift+Tab)
			if (e.key === "Tab" && dialogRef.current) {
				const focusableElements = dialogRef.current.querySelectorAll(
					'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
				);
				if (focusableElements.length > 0) {
					const first = focusableElements[0] as HTMLElement;
					const last = focusableElements[
						focusableElements.length - 1
					] as HTMLElement;

					if (e.shiftKey && document.activeElement === first) {
						e.preventDefault();
						last.focus();
					} else if (!e.shiftKey && document.activeElement === last) {
						e.preventDefault();
						first.focus();
					}
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isOpen, filteredCommands, selectedIndex, onClose]);

	if (!isOpen) return null;

	const handleExecute = (cmd: CommandItem) => {
		onClose();
		cmd.action();
	};
	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes modal */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click closes modal */}
			<div
				className="command-palette-backdrop"
				onClick={(e) => {
					if (e.target === e.currentTarget) {
						onClose();
					}
				}}
				data-testid="command-palette-backdrop"
			>
				<div
					ref={dialogRef}
					className="command-palette-dialog"
					role="dialog"
					aria-modal="true"
					aria-label="Komut Paleti"
					data-testid="command-palette-dialog"
				>
					<div className="command-palette-header">
						<Search
							size={18}
							className="command-palette-search-icon"
							aria-hidden="true"
						/>
						<label htmlFor={searchInputId} className="sr-only">
							Komut ara
						</label>
						<input
							ref={inputRef}
							id={searchInputId}
							type="search"
							className="command-palette-input"
							placeholder="Bir komut veya sayfa ara..."
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							autoComplete="off"
							spellCheck="false"
							data-testid="command-palette-input"
							aria-autocomplete="list"
							aria-controls="command-palette-list"
						/>
						<kbd className="command-palette-esc-badge" aria-label="Escape tuşu">
							ESC
						</kbd>
					</div>

					<section
						className="command-palette-body"
						// biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region requires tabIndex for axe
						tabIndex={0}
						aria-label="Komut listesi"
					>
						{filteredCommands.length === 0 ? (
							<div
								className="command-palette-empty"
								role="status"
								data-testid="command-palette-empty"
							>
								Eşleşen komut bulunamadı.
							</div>
						) : (
							<div
								ref={listRef}
								id="command-palette-list"
								className="command-palette-list"
								role="listbox"
								aria-label="Komutlar"
								data-testid="command-palette-list"
							>
								{filteredCommands.map((cmd, index) => {
									const isSelected = index === selectedIndex;
									return (
										<div
											key={cmd.id}
											id={`command-item-${cmd.id}`}
											role="option"
											tabIndex={-1}
											aria-selected={isSelected}
											className={`command-palette-item ${isSelected ? "selected" : ""}`}
											onClick={() => handleExecute(cmd)}
											onKeyDown={(e) => {
												if (e.key === "Enter" || e.key === " ") {
													e.preventDefault();
													handleExecute(cmd);
												}
											}}
											onMouseEnter={() => setSelectedIndex(index)}
											data-testid={`command-item-${cmd.id}`}
										>
											<div className="command-palette-item-icon">
												{cmd.icon}
											</div>
											<span className="command-palette-item-title">
												{cmd.title}
											</span>
											<span className="command-palette-item-category">
												{cmd.category}
											</span>
										</div>
									);
								})}
							</div>
						)}
					</section>
				</div>
			</div>
		</>
	);
}

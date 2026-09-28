import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";

export interface QuickEntryContextValue {
	isOpen: boolean;
	selectedTemplateId: string | null;
	openQuickEntry: (templateId?: string | undefined) => void;
	closeQuickEntry: () => void;
	selectTemplate: (templateId: string | null) => void;
}

const QuickEntryContext = createContext<QuickEntryContextValue | null>(null);

export function QuickEntryProvider({ children }: { children: ReactNode }) {
	const [isOpen, setIsOpen] = useState(false);
	const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
		null,
	);

	const openQuickEntry = useCallback((templateId?: string | undefined) => {
		setSelectedTemplateId(templateId ?? null);
		setIsOpen(true);
	}, []);

	const closeQuickEntry = useCallback(() => {
		setIsOpen(false);
		setSelectedTemplateId(null);
	}, []);

	const selectTemplate = useCallback((templateId: string | null) => {
		setSelectedTemplateId(templateId);
	}, []);

	const value = useMemo(
		() => ({
			isOpen,
			selectedTemplateId,
			openQuickEntry,
			closeQuickEntry,
			selectTemplate,
		}),
		[
			isOpen,
			selectedTemplateId,
			openQuickEntry,
			closeQuickEntry,
			selectTemplate,
		],
	);

	return (
		<QuickEntryContext.Provider value={value}>
			{children}
		</QuickEntryContext.Provider>
	);
}

const defaultQuickEntryValue: QuickEntryContextValue = {
	isOpen: false,
	selectedTemplateId: null,
	openQuickEntry: () => {},
	closeQuickEntry: () => {},
	selectTemplate: () => {},
};

export function useQuickEntry(): QuickEntryContextValue {
	const ctx = useContext(QuickEntryContext);
	return ctx ?? defaultQuickEntryValue;
}

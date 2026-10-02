import React, { Suspense, useCallback, useEffect, useState } from "react";

const LazyCommandPalette = React.lazy(() =>
	import("./CommandPalette").then((m) => ({ default: m.CommandPalette })),
);

export function CommandPaletteHost() {
	const [isOpen, setIsOpen] = useState(false);
	const [hasBeenOpened, setHasBeenOpened] = useState(false);

	const handleOpen = useCallback(() => {
		setHasBeenOpened(true);
		setIsOpen(true);
	}, []);

	const handleClose = useCallback(() => {
		setIsOpen(false);
	}, []);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const isMac =
				typeof navigator !== "undefined" &&
				/Mac|iPod|iPhone|iPad/.test(navigator.platform);
			const isKModifier = isMac ? e.metaKey : e.ctrlKey;

			if (isKModifier && e.key.toLowerCase() === "k") {
				const activeEl = document.activeElement;
				const isEditable =
					activeEl instanceof HTMLInputElement ||
					activeEl instanceof HTMLTextAreaElement ||
					activeEl instanceof HTMLSelectElement ||
					Boolean(activeEl?.getAttribute("contenteditable") === "true") ||
					Boolean((activeEl as HTMLElement | null)?.isContentEditable);

				// Only intercept if not currently typing in a native input/textarea
				if (!isEditable) {
					e.preventDefault();
					if (isOpen) {
						handleClose();
					} else {
						handleOpen();
					}
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isOpen, handleOpen, handleClose]);

	if (!hasBeenOpened && !isOpen) {
		return null;
	}

	return (
		<Suspense fallback={null}>
			<LazyCommandPalette isOpen={isOpen} onClose={handleClose} />
		</Suspense>
	);
}

import { CsvImportForm } from "./CsvImportForm";
import { ImportBatchList } from "./ImportBatchList";

export function ImportsPage() {
	return (
		<div className="page-container imports-page" data-testid="imports-page">
			<header className="page-header">
				<h1 className="page-title">Ekstre İçe Aktar</h1>
				<p className="page-subtitle">
					CSV ekstrelerinizi yükleyin, mükerrer kayıtları inceleyin ve
					hareketleri sisteme aktarın.
				</p>
			</header>

			<div className="imports-layout">
				<section className="imports-form-section">
					<CsvImportForm />
				</section>

				<section className="imports-list-section">
					<ImportBatchList />
				</section>
			</div>
		</div>
	);
}

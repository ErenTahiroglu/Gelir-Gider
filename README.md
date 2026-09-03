# Gelir-Gider Backend

Tek kullanıcılı, private kişisel finans (Personal Finance) uygulamasının backend servisidir.

## Proje Durumu (Current Phase)

* **Phase 1:** Cloudflare Worker backend iskeleti, TypeScript yapılandırması ve kalite kapıları (quality gates) kuruldu.
* **Finans / Ledger / Veritabanı:** Henüz geliştirilmedi / implemente edilmedi (Phase 2 ve sonraki aşamalarda kurulacaktır).

## Hedef Mimari Stack

* Cloudflare Workers (Edge Runtime)
* TypeScript (Strict mode, ES2022)
* Hono (Web routing framework)
* Neon PostgreSQL (Serverless database - sonraki phase)
* PostgreSQL `NUMERIC(18,2)` para yönetimi (sonraki phase)
* WebAuthn / Passkey kimlik doğrulama (sonraki phase)
* Vitest + `@cloudflare/vitest-plugin` (Workers runtime tabanlı testler)
* Biome (Linter & Formatter)

## Ön Gereksinimler

* Node.js (>= 20)
* npm (>= 10)

## Kurulum

```bash
npm install
```

## Geliştirme

Lokal geliştirme sunucusu:

```bash
npm run dev
```

Worker tiplerini güncellemek için:

```bash
npm run cf-typegen
```

## Test ve Kalite Kapıları (Quality Gates)

Tüm kalite kapılarını (`cf-typegen`, `typecheck`, `lint`, `format:check`, `test`) tek komutla çalıştırmak için:

```bash
npm run check
```

Bileşenleri ayrı ayrı test etmek için:

* **Tip Denetimi:** `npm run typecheck`
* **Linter:** `npm run lint`
* **Format Denetimi:** `npm run format:check`
* **Format Düzenleme:** `npm run format`
* **Testler:** `npm test`

## Dağıtım (Deployment)

`package.json` içerisinde `deploy` (`wrangler deploy`) script'i tanımlıdır; ancak **Phase 1 kapsamında herhangi bir remote dağıtım yapılmamıştır ve yapılmayacaktır**. Dağıtım aşaması güvenlik ve veritabanı altyapısı hazır olduğunda aktif edilecektir.

# Gelir-Gider — logo dosyaları

## Renkler
| Rol | HEX |
|---|---|
| Navy 950 — uygulama zemini | #08111F |
| Navy 900 — yüzey / ikon karosu | #0D1728 |
| Navy 800 — yükseltilmiş yüzey | #162238 |
| Çizgi / border | #26344F |
| Indigo 400 — koyu zeminde vurgu (Gelir yayı) | #6C62FF |
| Indigo 500 — açık zeminde vurgu / ana marka rengi | #5B4FF5 |
| Indigo 300 — favicon (koyu sekme) | #7A71FF |
| Mist 50 — koyu zeminde işaret & metin | #EEF0FA |
| Slate 400 — ikincil metin (koyu) | #8C98B2 |
| Paper — açık zemin | #F6F7FB |

## Dosyalar
- svg/mark-dark-ui.svg, svg/mark-light-ui.svg — ana işaret (şeffaf)
- svg/mark-mono.svg, svg/lockup-mono.svg — tek renk (`currentColor`, CSS `color` ile boyanır; mask-image için uygun)
- svg/mark-micro.svg — ≤32 px için sadeleştirilmiş geometri
- svg/lockup-*.svg — yatay logo (yazı vektöre çevrildi, font gerekmez)
- favicon.svg (açık/koyu temaya uyumlu), favicon.ico (16/32/48)
- png/icon-192.png, png/icon-512.png — purpose "any"
- png/maskable-192.png, png/maskable-512.png — purpose "maskable" (görsel %51 genişlik, %80 güvenli dairenin içinde)
- png/apple-touch-icon.png — 180×180

## manifest.webmanifest
```json
"theme_color": "#08111F",
"background_color": "#08111F",
"icons": [
  { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
  { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
  { "src": "/icons/maskable-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" },
  { "src": "/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
]
```
## <head>
```html
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#08111F">
```

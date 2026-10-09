# Server localization foundation

English and Italian catalogs cover domain errors, authentication errors, support-session messages, job states and plain-text verification/reset/link/invitation emails. This package has no graphical frontend; the M6 React localization adapter can consume the shared message identifiers and game namespaces.

`resolveLocale` uses a supported account preference first, then quality-sorted `Accept-Language`, then English. `translate` interpolates named parameters without evaluating them; rendering layers must apply their usual output escaping. `localizeError` and `localizeAuthError` never return raw upstream messages. Unknown provider codes use the localized internal-error message.

Catalog parity checks require matching keys and parameter names for both shipped locales. `CatalogRegistry` permits separately loaded, namespaced game catalogs and rejects collisions. Unknown locales fall back to English; unknown message identifiers and missing parameters fail explicitly. Native `Intl` supplies number, date and relative-time formatting. Plain-text email rendering validates HTTP(S) links and rejects instance names containing mail-header newlines.

Run the package tests from the repository root:

```sh
scripts/dev.sh pnpm test -- packages/i18n
```

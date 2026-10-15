# M5 Owner integration administration

## Scope and ownership

The Owner opens an installed integration from `/owner/integrations` and configures
it through URL-addressable tabs. Generic sections work for a compiled integration
without a bespoke game renderer. Minecraft supplies Versions and Gateway messages.
Ordinary users do not receive this administration/evidence interface.

| Location | Owns | Kept elsewhere |
| --- | --- | --- |
| Integration → General | Rollout and tester allowlist | User/account administration |
| Integration → Runtime | Runtime/egg mapping, image policy, startup variables, port roles | Physical hosts, nodes, allocation pools and provider discovery remain Infrastructure |
| Integration → Versions | Mapping-specific catalog, availability, scan and evidence detail | Ordinary creation only receives eligible choices |
| Integration → Connection | Domain policy and game-specific response presentation | Platform domains, DNS credentials and Gateway routes |
| Integration → Sleep/Wake | Game/runtime timeout and visibility overrides | Global defaults in Settings; server overrides on the server |
| Integration → Content limits | Scoped caps, free-space floors and narrowed download origins | Global paths, aggregate budgets, metadata identity and trust in Settings → Content |

Infrastructure has a mapping overview linking to the sole Runtime editor. A used
mapping exposes only its enabled flag for editing; server/provider identities are
not retargeted. Settings no longer duplicates Minecraft Gateway responses or
protocol-source editors. Global sections have links from the relevant integration
page, including direct runtime sleep navigation.

Shared staging policy counts all games and users in one PostgreSQL aggregate under
the existing admission lock. Overrides cannot multiply global budgets or widen
configured download trust. There is no new provider call in content admission.
[Migration/aliases/rollback](CONFIGURATION-AND-DEPLOYMENT.md#shared-content-limits-and-integration-overrides-2026-10-16)
and [API contracts](M5-API-CONTRACTS.md#owner-integration-policies-2026-10-16)
are authoritative.

## Interaction and verification boundaries

Tabs load their own data; catalog filters/selection survive switches. A started
catalog scan stays alive across tabs in the same workspace, with one shared query
cache. Leaving/reloading the workspace still cancels browser-driven scanning.
This change does not claim durable server-side catalog jobs. Unsaved form edits
are not retained across tab navigation; use Save changes before switching tabs.

Loading, empty, request errors and environment locks remain explicit. Disabled
rollout does not prevent Owner configuration. Local content limits show inherited
and effective values; clearing an override restores inheritance. Gateway custom
responses require both EN/IT translations, or clearing both restores the built-in
message. Incomplete drafts in another state are caught before saving.

Browser evidence uses actual React components with isolated API responses, plus
existing real-handler browser journeys using disposable PostgreSQL schemas.
External providers are fixtures. No screenshots or tests establish new Minecraft
runtime certification, real DNS reachability or production readiness.

## Validation (2026-10-16)

- Targeted unit command: `scripts/dev.sh pnpm exec vitest run packages/core/src/core.test.ts packages/core/src/content-policy.test.ts packages/server-management/src/content-admission.test.ts packages/game-sdk/src/ui.test.ts apps/web/src/features/game-ui.test.ts apps/worker/src/minecraft-metadata.test.ts scripts/deployment-config.test.ts` — **132 passed**.
- Source/content DB cases via `scripts/test-env.ts --m2`: existing Minecraft sources **18 passed**; cross-game policy/admission/recovery **6 passed**. Concurrent claims prove shared global/user caps and retained uncertainty. Foreign-game inventory/recovery is rejected.
- Scoped integration policy API: **7 covered/passed**, including concurrent scoped merges, authorization, environment locks, inheritance and mapping `inUse`. The initial run passed six and exposed a missing provider-URL test fixture; the corrected runtime case passed its targeted rerun.
- Legacy settings reset: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/web-session.integration.test.ts -t 'exposes only Owner configuration schemas'` — **1 passed**, five unrelated cases deselected.
- New workspace browser suite: **four passed**, followed by **one additional passing targeted regression** for rapid keyboard/filter changes; content/message forms: **six passed**. Tests cover trusted generic fallback, scoped saves, immutable mapping fields, lazy requests, scan continuity, URL filters, mobile EN/IT, keyboard traversal, environment locks and incomplete translations. Axe AA checks pass on the reviewed runtime, mobile sleep and content screens.
- Production build, root/web typecheck, formatting and compiled EN/IT/pseudolocale checks pass. Lint has no errors; existing warnings remain. Build retains the existing large-chunk warning for document/rendering libraries.

Initial new-test failures were fixture-only: rowheader versus cell locator, missing
terminal-job timestamp and an already-seeded settings row. Corrected cases were
rerun. Independent backend review found legacy-reset normalization and foreign-game
recovery scope gaps; both were corrected with tests. Independent frontend review
found the blank alternate-locale response; both EN-only and IT-only cases now
reject incomplete saves. No remaining must-fix findings from those reviews.

The additional run of three existing browser suites initially reported **11
passes, seven failures and six skipped cases**. Failures exposed stale wizard
navigation (the address step was missing), a Gateway setup fixture enabling it
before identity configuration, retained scan options, an assertion racing URL
navigation, and the General form losing its save notice during refetch. The
General form behavior was corrected. Follow-up tests also exposed a real race
between rapid filter changes and URL navigation, plus mobile catalog overflow.
The catalog now applies explicit field patches to the latest pending URL, and
the workspace grid keeps catalog scrolling inside its available width.

Focused follow-ups: Platform **three passed, nine deselected**; inherited sleep
**six passed**; Vanilla catalog **five passed, one failed** before the mobile fix,
then its final ordered regression subset **three passed, three deselected**.
Together with the initially passing cases, all 24 existing cases are covered by
passing runs. This is targeted rerun evidence, not a new full-suite pass.
The initial failures remain recorded above. A synthetic same-JavaScript-turn
input-reset test was reproduced against an ordinary React transition-controlled
input and replaced with real keyboard typing/selection/deletion; that regression
passes without special handling in the application.

The optional test-persistence restart script stopped at its approval guard; no
service restart was attempted. Persistence restarts are not needed for this
change. The historical full M1–M5 suites and live game scenarios were not repeated.

## Reviewed screenshots

- [General, desktop EN](screenshots/m5/integration-general-desktop-en.png)
- [Runtime, desktop EN](screenshots/m5/integration-runtime-desktop-en.png)
- [Sleep/Wake, mobile IT](screenshots/m5/integration-sleep-mobile-it.png)
- [Content limits, desktop EN](screenshots/m5/integration-content-desktop-en.png)
- [Content limits, mobile IT](screenshots/m5/integration-content-mobile-it.png)

Screenshots contain isolated fixture identities. Technical/accessibility/UX review
found compact layouts without horizontal page overflow. Nonblocking observation:
unsaved tab drafts are not preserved, as stated above.

## Deployment and safety

Migration 035 is required before new content operations. The read-only development
preflight found it as the only pending migration, with two users, three retained
server registry rows, one runtime mapping, one physical host and empty content
ledgers. Applying it requires the separately requested scoped approval. No files,
provider resources or credentials are reset. Runtime source/translation hot reload
remains available; the dev HTTPS page and API/worker/Vite health checks returned
healthy during validation.

No Pterodactyl/Wings, DNS, networks, production containers or game-server data were
mutated. Disposable test schemas were cleaned by their harness. SFTPGo issue #18
remains the separate production-release gate. PR #21 remains open and unmerged.

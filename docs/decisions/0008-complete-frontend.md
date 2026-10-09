# ADR 0008 — Complete frontend in its own final milestone

**Status:** Accepted, amended 2026-10-09. The original decision below is retained
as history; the amendment defines current M5/M6 ownership.

## Decision

M6 entirely owns the user and Owner UI, built after core and both initial game integrations. Deliver complete functional screens and end-to-end flows, not an MVP or mocked placeholder panel. Run real browser UI and provide sanitized screenshots for iterative Owner/ChatGPT review. Internationalize every user-facing component, notification and email; English+Italian at launch, easy extra locales.

## Consequences

M1–M5 need typed contracts, integration tests and test harnesses rather than partial UIs. Real progress, console+CPU/RAM/network graphs, plugin-injected views, complete Owner assisted sessions and game-specific content management are M6 acceptance requirements.

## Owner-approved amendment — 2026-10-09

Move the complete user and Owner frontend from M6 to **M5 — Complete WebPanel &
Common Platform Readiness**. Move Satisfactory and game integration expansion to
**M6**. Keep exactly M0–M6 and preserve M0–M4 historical scope. The corresponding
future branches are `milestone/m5-webpanel` and `milestone/m6-game-integrations`.
This change does not authorize starting either milestone or deploying production
resources.

All frontend quality requirements remain: complete real flows, screenshots,
responsive/accessibility review, English/Italian and no disposable mock interface.
M5 also finishes reusable backend/API/worker/SDK functions needed by the WebPanel,
including conditional wizards, management tabs, multiport networking, files/SFTP,
backups, project/server sharing permissions and job recovery. These common
functions must not depend on Satisfactory being implemented. The explicit gate is
[M5 common integration readiness](../M5-COMMON-INTEGRATION.md), alongside
[Frontend and i18n](../FRONTEND-I18N.md) and the [roadmap](../MILESTONES.md).

Vanilla is the only runtime with M4 real-server verification; ordinary users see
only eligible, Owner-enabled combinations with sufficient evidence. Experimental
and unverified runtime/game choices remain within the existing Owner/private-test
controls. M6 adds Satisfactory's actual behavior and complete UI contributions
through the finished M5 platform, without fake Satisfactory screens in M5.

The current consequence is that **M1–M4** use backend contracts and test harnesses;
**M5** completes the app and shared platform; **M6** expands integrations. Preserve
the SFTPGo exception and issue #18, production approval boundaries and evidence
requirements. This amendment changes sequencing, not safety or acceptance quality.

Keep the original GitHub milestone/issue identities and history: M5/M6 milestone
IDs 6/7 receive the new names/scopes; issues #14/#15 move to M5 and #12/#13 to M6.
Issue #18 remains open as a cross-milestone production-release gate without a
milestone assignment. It is not an implicit M5 implementation task or a deferral
to M6. The tracking changes require their own verification and do not add an M7.

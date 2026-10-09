# Prompts for Codex

## Prepping (no PR)

```text
Read PREPPING.md and AGENTS.md in the dedicated nickhosting-panel workspace. Inspect any existing .codex configuration and reconcile the provided project-local multi-agent settings without overwriting unrelated options. Verify git/gh/pnpm/Node, gh auth status, and recognition of the researcher, implementer and reviewer profiles. Spawn the custom researcher and reviewer for independent read-only documentation checks; distinguish profile settings from effective sandbox enforcement. Verify starter archives, secrets, .env files and persistent data stay excluded from Git. Do not initialize the project Git repository, create GitHub resources, access production or start M0. Return a precise readiness report and blockers, then stop for Owner review.
```

## M0 — create public GitHub repository and PR

```text
Begin M0 only; read AGENTS.md, docs/MILESTONES.md (M0), docs/GITHUB-WORKFLOW.md and the complete project spec. Create the new public GitHub repo named nickhosting-panel using gh CLI, under the intended authenticated account after checking ownership; this repo is separate from the nickhost.ing website repo. Use a minimal main baseline, import the approved project docs/ADRs/.codex configuration/agent profiles/GitHub PR & issue templates in a milestone branch, and set up GitHub Issues/Milestones/labels (optional simple Project board). Do not enable GitHub Actions, do not add a license without asking, do not change existing live infrastructure. Verify gitignored mountdata/env and public repo hygiene. Open draft M0 PR, finalize review evidence, mark ready when actually complete, then STOP; report PR URL, HEAD SHA, tests/checks, blockers. Do not merge or begin M1.
```

## General M1–M6 template

```text
Implement only Milestone M<N> on a dedicated branch based on the current reviewed/merged main, according to AGENTS.md and docs/MILESTONES.md. Read relevant architecture/domain docs first. Divide independent tasks among no more than 3 appropriate subagents with non-overlapping file ownership and a read-only reviewer. Update contracts, docs and ADRs, run reproducible checks and report evidence. You may use real Pterodactyl APIs and create/mutate/destroy only test servers with conclusively proven Codex-created provenance. Never modify existing/uncertain servers or live Docker/Wings/Panel/Compose/networks/firewall/DNS without operation-specific Owner approval; stop and ask when uncertain. Open milestone PR and leave it unmerged for Owner/reviewer. Return PR URL, HEAD SHA, tests, test assets/provenance/cleanup, and any permission blockers. Do not start next milestone.
```

## M5 WebPanel and common platform readiness

```text
Implement M5 only after explicit Owner authorization, on milestone/m5-webpanel from reviewed main. Read docs/M5-COMMON-INTEGRATION.md and close its common API gaps through existing M1–M4 backends; do not duplicate lifecycle or provider logic. Deliver the complete user/Owner React app for verified capabilities, with Minecraft Vanilla first. Satisfactory is not a prerequisite; no fake screens, unsupported choices or dead navigation. Use SDK capability/conditional-wizard/port-role descriptors and Owner evidence gates. Follow docs/FRONTEND-I18N.md: task flows before visuals, compact factual English/Italian, no marketing or generic AI dashboard styling, WCAG 2.2 AA, keyboard/focus and independent UX/content review. Run the actual browser app, capture real screenshot evidence in both en/it across desktop/mobile and relevant states, compare against UX requirements, correct visual and interaction issues iteratively. Do not claim screenshot coverage if no browser execution occurred. Include sanitized screenshots/links and reproducible browser validation commands in the PR. Leave PR open for review.
```

## GitHub PR reviewer prompt (for ChatGPT)

```text
Review the NickHosting Panel PR at <url> against AGENTS.md, docs/MILESTONES.md and the approved ADRs. Focus on functional correctness, security boundaries, Pterodactyl/Wings non-interference, data ownership, async job correctness, tests, i18n, common API integration, capability gating, M5 UX/content/accessibility and later game-specific UI when applicable. Identify concrete must-fix findings with file/line references and recommendations. Do not merge or alter production.
```

## M6 game integration expansion

```text
Implement M6 only after explicit Owner authorization and reviewed M5, on milestone/m6-game-integrations. Build Satisfactory runtime/egg verification, exact ports, specialized configuration/saves/player status, SMR/SML and scoped SMM integration through the existing WebPanel/SDK. Declare readiness/idle/wake only with empirical evidence. Additional Minecraft runtime/game certifications require compatible eggs and real tests; none is retroactively an M5 prerequisite. Preserve the open SFTPGo production-release gate #18. Observe all infrastructure approvals and provenance rules. Leave the milestone PR open and unmerged.
```

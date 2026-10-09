## Milestone and scope

- Milestone: M?
- Linked Issues: Closes #...
- Branch / HEAD SHA:
- Summary of completed requirements:

## Requirements checklist

Copy the assigned milestone's acceptance requirements from `docs/MILESTONES.md` into concrete checklist items. Check an item only when its evidence is included below; explain blocked items explicitly.

- [ ] Assigned milestone acceptance requirements listed and verified
- [ ] No implementation from a later milestone included

## Implementation / decisions

- Architecture/API/DB changes:
- Configuration and migrations:
- Updated ADRs/docs:
- Known limitations or deferred functionality (must not contradict milestone acceptance):
- Capability gating / common API integration acceptance (M5) or new game evidence (M6):
- Production-release gates, including unresolved SFTPGo issue #18 (separate from milestone implementation):

## Verification (real results only)

| Check | Command or reproduction | Result | Evidence |
|---|---|---|---|
| Lint/typecheck | | | |
| Unit/integration | | | |
| Production-safe Pterodactyl test (if used) | | | |
| Browser/screenshots + UX/content review (M5; later UI changes) | | | |

## Production safety and test provenance

- [ ] No pre-existing or ambiguously owned Pterodactyl server was modified.
- [ ] No unauthorized production Docker/Wings/Panel/network/DNS/firewall changes occurred.
- [ ] Every Pterodactyl test server created by this PR is documented below with verified provenance, or test assets are explicitly reported as none.
- [ ] Secrets, raw tokens, closed-source source files and private persistent data are absent from commits/logs/screenshots.

Test asset provenance and cleanup (use `None` if no assets were created):

Approved external changes, if any (link explicit Owner approval):

## Reviewer focus

1. Highest-risk implementation change:
2. Reproduction steps:
3. Known blockers / Owner decisions:
4. Rollback:

## Final handoff

- PR URL and HEAD SHA:
- [ ] Independent subagent review complete
- [ ] All acceptance items verified or explicitly flagged as blocked
- [ ] PR remains OPEN; no auto-merge

# Game Integration SDK foundation

This package defines contracts for trusted first-party integrations. Game implementations arrive in their assigned milestones. `defineGameIntegration` validates the manifest, runtime/handler correspondence, translation namespaces and required lifecycle handlers before registration. Capabilities describe actual tested functionality; declaring a handler does not constitute empirical protocol verification.

Plugins declare symbolic runtimes, port roles, wizard steps, management contributions, connection modes, capabilities and locale namespaces. Pterodactyl nest/egg IDs live in Owner-supplied `RuntimeEggMapping` records. `AuthorizedGameServices` represents services bound by core to one permitted server and operation, with actor and resource owner recorded separately. It exposes no infrastructure credentials or unrestricted adapter.

Persist exactly these rollout states: `development`, `private-testing`, `public`, `disabled-for-new-servers`. Use `evaluateGameAccess` consistently in catalogs, dynamic routes and creation handlers:

| State | Creation |
| --- | --- |
| development | Owner |
| private-testing | Owner and allowlisted user IDs |
| public | Authenticated users |
| disabled-for-new-servers | Nobody, including Owner |

Owner retains visibility. Existing servers remain visible/manageable to users whose resource access was separately authorized, even after rollout changes. Pass `hasExistingServerAccess` only after core resource authorization; rollout policy alone never grants server ownership or membership. Removing a plugin binary still requires a future migration/fallback decision.

Run the package tests from the repository root:

```sh
scripts/dev.sh pnpm test -- packages/game-sdk
```

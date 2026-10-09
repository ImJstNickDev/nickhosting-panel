# Prepping — before milestone M0

**Objective:** prepare Codex for a coordinated multi-agent project *without creating GitHub resources or changing production*. Prepping is **not** a milestone and does **not** require a PR. M0 will commit these files in its PR.

## Procedure

1. Choose an empty local working directory intended to become `nickhosting-panel` (do not reuse the existing public-site repository).
2. Inspect whether the workspace already contains `.codex/` or `AGENTS.md`; **preserve and reconcile existing settings**, do not blindly overwrite them.
3. Copy this starter kit into that workspace. Merge `.codex/config.toml` while preserving unrelated project/user configuration. Keep the settings below:

   ```toml
   [agents]
   enabled = true
   max_concurrent_threads_per_session = 3
   ```

4. Verify the project-local `researcher`, `implementer` and `reviewer` profiles (see `.codex/agents/`). Check CLI compatibility with current `codex --version` and the [official Codex subagents docs](https://learn.chatgpt.com/docs/agent-configuration/subagents). Do not pin a model name unless the installed Codex explicitly supports it.
5. Verify `AGENTS.md` and the production-safety rules are visible to parent and subagents. Test spawning **one custom read-only `researcher` and one custom read-only `reviewer`** on independent documentation checks. Confirm role instructions and effective permissions separately: a profile requesting `sandbox_mode = "read-only"` does not prove that a client/session override enforces it. Neither agent may edit files or access production.
6. Check `git`, Git commit identity, `gh`, `pnpm`, Node LTS compatibility and authentication with `gh auth status` and `gh api user --jq '.login'` (read-only checks; never print tokens). Verify the host-specific Git transport with `gh config get git_protocol --host github.com`; check that transport's authentication without changing credentials or SSH known hosts. Check available M0 CLI commands via `--help`. Do not initialize the project Git repository or run `gh repo create` until M0.
7. Inspect public-repository hygiene: starter archives, real `.env` files, secrets and persistent data must stay excluded; `.env.example`, `.codex` profiles and SQL migrations must remain versionable. Test ignore behavior in a disposable scratch fixture outside the workspace, without staging project files. Check local documentation links and templates. Do not unpack archives or copy private installation files into the project.
8. Record discrepancies or tool limitations in the Prepping handoff. No PR, implementation, deployment, production access or server creation in Prepping. Stop for Owner review before M0.

## Configuration compatibility and prerequisites

The configuration above was verified with **Codex CLI 0.162.0**. `agents.max_concurrent_threads_per_session = 3` allows three spawned agents in addition to the primary agent. Standalone TOML profiles under `.codex/agents/` are discovered automatically; no duplicate role registrations or model pins are needed. See the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). Preserve unrelated user and project configuration, including existing trust and model preferences.

Use `codex features list` and `codex doctor --json` to inspect the installation (share only sanitized results). On 0.162.0, `--strict-config` is **not supported by `codex features`**. Strict validation can instead use an isolated `codex --strict-config app-server --stdio` process, then JSON-RPC `initialize`, `initialized`, and `config/read` with this workspace as `cwd` and `includeLayers: true`. Confirm the project layer is enabled and supplies both agent keys, then close that temporary process; do not reconfigure or restart the shared daemon. A fresh invocation's configuration is not proof of an already-running session's effective sandbox.

M0 needs Git identity, authenticated GitHub access, working Codex delegation and safe documentation import. Actual write permissions cannot be proven by read-only checks; verify them when M0 is authorized. The optional GitHub Project board is not a blocker if the CLI or token lacks Projects support. Do not add a LICENSE without the Owner's choice.

Check Node and pnpm now, but application scaffolding, dependency pins and runtime tests belong to M1. As of 2026-10-09 the local Node 20.20.2 runs pnpm 10.33.0, but Node 20 is end-of-life. Use a supported LTS release for M1 (Node 24 is the current LTS recommendation at this check), selected in an isolated development environment without changing live services. Verify the [Node release status](https://nodejs.org/en/about/previous-releases) and [pnpm 10 compatibility](https://pnpm.io/10.x/installation) again when implementing. Do not install dependencies or change host runtimes during this check. Docker/Compose client versions can be inspected without contacting the daemon; PostgreSQL, Redis, Pterodactyl and game-server connectivity are not M0 prerequisites.

## Paste into Codex for Prepping

> We are preparing an independent project called `nickhosting-panel`. Read `PREPPING.md`, `AGENTS.md`, and `.codex/config.toml` in this workspace. Reconcile any existing `.codex` settings (do not overwrite unrelated settings), verify working subagents with read-only documentation tasks, inspect tool versions and `gh auth status`, and report readiness for M0. Do not create a GitHub repo, touch any existing project, or mutate production. Stop and ask if the working directory/repository is ambiguous.

## Expected report

- Workspace path and repository detection result.
- Codex version and supported multi-agent configuration.
- Effective agent config and discovered profiles.
- `gh` auth status (never show tokens), Git identity/transport, Git/pnpm/Node versions and support status.
- Documentation, template, ignore-rule and sanitized secret-check results; changed preparatory files.
- M0 blockers versus later milestone prerequisites, effective sandbox limitations and Owner review requests.
- Branch, HEAD and PR status (not applicable before Git initialization), production interactions and test assets (none), and rollback for preparatory edits.

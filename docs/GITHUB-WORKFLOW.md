# GitHub-first solo workflow — no GitHub Actions

The public repository is [ImJstNickDev/nickhosting-panel](https://github.com/ImJstNickDev/nickhosting-panel). Repository and governance creation belong to **M0**; Prepping never creates GitHub resources. The Owner reviews and performs merges; Codex never merges a PR.

## Features to use

- **Issues:** 2–5 outcome-oriented issues for each milestone as needed (feature/bug/research/blocker), not every individual function. Use closing keywords on PRs for completed issues.
- **GitHub Milestones:** M0, M1, M2, M3, M4, M5, M6. Set an Issue/PR milestone where appropriate; `MILESTONES.md` is the canonical specification for acceptance.
- **Labels:** `type:feature`, `type:bug`, `type:research`, `area:auth`, `area:core`, `area:gateway`, `area:minecraft`, `area:satisfactory`, `area:frontend`, `needs:approval`, `needs:review`, `blocked`, `priority:high`. Keep labels minimal.
- **One GitHub Project (optional):** simple statuses `Backlog`, `In progress`, `In review`, `Done`, with cards corresponding to milestones/issues/PRs. Avoid duplicating the roadmap in a complex board.
- **Pull requests:** one milestone PR each, template below, drafts while implementation active, ready-for-review at completion. `main` remains the stable reviewed baseline.
- **Discussions:** not required. Keep important decisions in ADRs, not ephemeral comments.
- **Releases/tags:** optional after accepted milestones or first production-ready release, not mandatory per PR.
- **Security:** never commit secrets; no GitHub Actions or automated workflows by default. GitHub native branch rules can be considered if plan permissions allow, but **do not require an external reviewer that blocks solo merges**.

## M0 GitHub CLI workflow (illustrative, execute only in M0)

```bash
# Run these only after verifying the working directory is the NEW panel project.
gh auth status
gh api user --jq '.login'   # verify intended owner, ask if ambiguous

git init -b main
# Stage a minimal baseline blob without changing the existing README on disk.
m0_readme_blob=$(printf '# NickHosting Panel\n' | git hash-object -w --stdin)
git update-index --add --cacheinfo "100644,$m0_readme_blob,README.md"
git diff --cached --check
# Inspect the baseline: only the minimal README may be staged.
git diff --cached --name-status
git diff --cached
git commit -m 'chore: initialize repository'

# Create the repository, disable Actions before the first push, then publish main.
gh repo create OWNER/nickhosting-panel --public --source=. --remote=origin
gh api --method PUT repos/OWNER/nickhosting-panel/actions/permissions -F enabled=false
git push -u origin main

git switch -c milestone/m0-repository
# Import reviewed files, including the intact full README and Prepping fixes.
git add -- README.md AGENTS.md PREPPING.md GUIDA-AVVIO-IT.md \
  .gitignore .env.example .codex/config.toml .codex/agents \
  .github/ISSUE_TEMPLATE .github/PULL_REQUEST_TEMPLATE.md docs
git diff --cached --check
git diff --cached --name-status
git diff --cached
# STOP and inspect the staged paths and contents locally before committing:
# no archives, real secrets, runtime state, closed-source files or workflows.
git commit -m 'docs: establish project specification and Codex governance'
git push -u origin milestone/m0-repository

gh pr create --draft --base main --head milestone/m0-repository \
  --title 'M0: repository bootstrap and development governance' \
  --body-file .github/PULL_REQUEST_TEMPLATE.md
```

**Important:** above is an example, not an instruction to overwrite an existing repository. If `git status` or `gh repo view` reveals that it already exists, inspect and ask before reinitializing. Branch/commit workflow must preserve any successful Prepping changes to `.codex/`; only minimal README is committed directly to `main` as a PR base.

Run the example step by step only after M0 authorization, stopping on any failed command. The baseline is written directly to Git's index; the full README remains untouched in the working tree until it is deliberately staged on the milestone branch. Review the actual staged diff before **each** commit/push; explicit paths and `.gitignore` reduce accidental inclusion but cannot detect every secret in an allowed file. Never force-add private files. Keep starter archives outside the repository or ignored; add any intentionally sanitized fixture through a narrow, reviewed exception. SQL migrations remain versionable; real dumps belong under ignored `mountdata/`, `dumps/` or `backups/`.

To create milestones GitHub CLI can use `gh api -X POST repos/OWNER/nickhosting-panel/milestones -f title='M0 — Repository' ...` and similar for M1–M6; verify whether they already exist first. Create labels via `gh label create` as needed. Create Issues via `gh issue create --milestone ...` only after the milestone exists. Do not batch create many hundreds of issues.

The PR body template is meant to guide evidence; when using `--body-file`, **fill out the template with actual status and links**, do not submit an empty checklist as if requirements passed.

## Review routine

1. Codex opens draft PR early enough for incremental review, then marks ready after tests and an independent reviewer subagent.
2. Codex reports PR URL, milestone, branch, SHA, tests, screenshot evidence (M6), exact production interactions and provenance ledger state; document external permission blockers.
3. Owner sends PR URL to ChatGPT for review; reviewer inspects repository diff, APIs, acceptance criteria, and independently flags regressions/unsafe operations.
4. Codex responds to findings on same branch/PR and updates validation evidence.
5. Owner decides when to merge and performs the merge. Codex **never merges**.
6. Next milestone starts only from known reviewed/merged baseline. Keep history traceable with PR links and small clear commits inside large milestone PRs.

## No Actions policy

No `.github/workflows/*.yml`, hosted CI or automations as part of the default architecture. Codex runs local lint/types/tests/browser checks and pastes verified command results in PRs. If reproducibility later becomes painful, propose Actions separately for Owner approval; do not activate them by default.

GitHub Actions is disabled in repository settings during M0. Issue forms and the PR template are verified on the M0 branch; GitHub's default-branch template discovery becomes available after the Owner merges M0. No branch rule or required status check is implied by this bootstrap, and the optional Projects board is omitted.

## Public repository considerations

Public visibility does **not** force a license. Ask before adding an open-source license or copying any closed-source Blueprint code. Avoid exposing tokens in PR descriptions, logs, screenshots, commits, or issues. If real server data appears in a commit, stop and remediate safely rather than simply deleting it from the next commit.

# ADR 0016 — Declared provider readiness and responder continuity

**Status:** Accepted by the Owner, 2026-10-11; implemented in M5. Live validation pending.

## Context

The Owner requests that Minecraft route when Pterodactyl declares it ready,
retain the Gateway responder throughout startup and return to it after idle stop.
Repeated network/protocol/process verification after the live running event added
latency and races without changing the already authorized endpoint. This amends
the readiness portions of ADR 0012 and ADR 0013, preserving their historical text.

## Decision

Trusted compiled integrations may declare `readinessSource: provider_running`.
Minecraft opts in. Authenticated live Wings status is authoritative only for the
exact NickHosting-managed successful admitted start/restart, reservation, process
record, route and generation. Core checks current live status before committing.
Raw Docker running state, historical console lines, browser input and Owner
checkboxes cannot establish readiness. An egg's startup signal must be correct;
NickHosting no longer independently verifies game readiness after that signal.

A bounded authenticated receipt advances already authorized listeners within
their original lease. It does not repeat Panel identity, image or Minecraft
status checks to perform that transition. Initial reachability proof and complete
identity/topology/collision/binding checks at listener opening and renewal remain.
Other integrations retain protocol readiness unless explicitly compiled to opt in.

Protocol status still supplies player/idle evidence. Missing counts never mean
zero. Core checks the local host-bound process epoch, while lifecycle reconciliation
handles external stops and restart recovery. Admission, manual-stop suppression,
idle deadline, quiescence, durable stop and terminal resource release are unchanged.

During normal container churn, an existing leased responder may retain its socket
and show waking for a newer generation only with identical server/node/allocation,
endpoints, protocol and locale. This is presentation only: no new route, wake,
forwarding or lease authority. Failed identity/collision checks still close it.

## Consequences and verification boundary

Provider startup accuracy becomes part of the trusted runtime/egg contract. This
change does not certify another Minecraft runtime or protocol. Missing committed
job proof or unavailable startup streams retain protocol fallback. A silent stream
can delay fallback until its bounded sixty-second deadline; ordinary delivery has
no intentional readiness timer. Failed player probes suppress sleep without
unnecessarily withdrawing provider-confirmed forwarding.

Regression tests cover authority, stale receipts, process fences, idle unknowns,
container churn and listener safety. The next Owner-driven game cycle must measure
actual event-to-forwarding latency and continuity; unit tests cannot prove them.
No Pterodactyl/Wings configuration, network or production resource change is needed.
SFTPGo issue #18 remains a separate production-release gate.

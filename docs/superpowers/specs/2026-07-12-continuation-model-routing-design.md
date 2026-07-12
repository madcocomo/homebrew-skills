# Continuation Model Routing Design

## Status

Approved in discussion on 2026-07-12.

## Problem

The current model router makes one routing decision in `before_agent_start` and reuses it for every tool continuation in the same agent run. If the initial request remains on the user-selected model, continuation turns are never independently evaluated for downgrade opportunities. Shadow logs therefore duplicate the initial decision instead of measuring the dominant continuation traffic.

The router must operate at provider-request boundaries. Every tool batch that will trigger another provider request should receive an independent routing decision.

## Terminology

- **User model**: the exact model object selected by the user at the start of the current agent run.
- **Weak model**: a model from the router's configured downgrade pool.
- **Initial decision**: routing before the first provider request in an agent run.
- **Continuation decision**: routing after a tool batch and before the next provider request.
- **Weak lease**: temporary use of a configured weak model.

The design does not contain a strong-model role or an upgrade-to-strong strategy. `route=user` means no downgrade, or restoration of the exact user model.

## Goals

1. Independently route every eligible tool continuation.
2. Permit `user → weak` and `weak → user` at each continuation boundary.
3. Preserve deterministic safety gates while using a classifier for semantic downgrade decisions.
4. Let continuation classification use bounded, redacted tool-result evidence.
5. Restore the exact user model on classifier failure, weak failure, abort, or agent completion.
6. Produce shadow records that represent real per-continuation recommendations.
7. Preserve compatibility with existing version 1 configuration files and legacy audit logs.

## Non-goals

- Do not modify Pi core or add a request-scoped model API.
- Do not configure or discover a third "strong" model.
- Do not infer general task simplicity from tool names or regex matches alone.
- Do not add hysteresis or a minimum model lease. Oscillation is allowed when successive independent decisions differ.
- Do not persist prompt, assistant text, tool-result excerpts, or secrets in audit logs.

## Architecture

### Agent-run state

At `before_agent_start`, capture the exact current model once:

```ts
requestUserModel: RuntimeModel
```

This object remains the sole restoration target for the whole agent run. Later model-change events do not replace it.

Routing decisions use accurate names:

```ts
type RouteDecision = {
  route: "user" | "weak" | "reject";
  reasonCodes: string[];
};
```

### Initial routing

Initial routing keeps the existing conservative structure:

```text
user prompt
  → initial capsule and deterministic admission
  → classifier only when eligible
  → route=user or route=weak
  → active mode applies the downgrade when needed
```

An initial `scope_ambiguous` decision applies only to the initial provider request. It must not permanently suppress continuation classification.

### Continuation routing

For every `turn_end` containing a tool batch that will cause an automatic continuation:

```text
tool calls and results
  → build independent continuation classifier input
  → current-boundary hard-user gate
      ├─ hit: route=user without classifier
      └─ clear: run continuation classifier
                   ├─ route=user
                   └─ route=weak
  → apply model change before turn_end handler returns
  → Pi prepares the next provider request from the selected model
```

A `turn_end` with no tools does not classify because no automatic tool continuation exists.

## Continuation Safety Gate

Deterministic rules primarily reject downgrade; they do not attempt to infer broad semantic simplicity.

Hard-user signals include:

- sensitive or irreversible operation in the current boundary;
- current tool error or nonzero exit;
- failed verification;
- confirmed scope drift when a valid capsule exists;
- repeated-operation or no-progress limit;
- weak context-window incompatibility;
- actual model mismatch;
- other existing deterministic conditions that prove weak use unsafe for the next request.

Signal lifetimes follow the no-hysteresis requirement:

| Signal | Lifetime |
|---|---|
| Tool error / nonzero exit | Next continuation only |
| Verification failure | Next continuation only; later success can re-enable classification |
| Repeated operation / no progress | Counters persist but reset on observable progress |
| Scope drift | Persists while observed execution remains outside the validated capsule |
| Context incompatibility | Persists while current context exceeds weak capability |
| Actual-model mismatch | Restore user model at this boundary; reevaluate later |
| Sensitive operation | Current boundary only |

If the initial request has no complete capsule, scope drift cannot be proven deterministically. This uncertainty is sent to the continuation classifier instead of becoming a permanent user-model decision.

## Classifier Protocol Version 2

Initial and continuation classification share a new output protocol:

```json
{
  "protocolVersion": 2,
  "route": "weak|user",
  "confidence": 0.0,
  "riskFlags": [],
  "reasonCode": "..."
}
```

The classifier system prompt must use `user`, not the legacy `strong` term.

The input distinguishes decision kinds:

```ts
interface ClassifierInputV2 {
  protocolVersion: 2;
  decisionKind: "initial" | "continuation";
  requestId: string;

  originalPromptExcerpt: string;
  currentObjective?: string;
  currentPhase?: string;
  recentAssistantText?: string;

  toolCalls: Array<{
    name: string;
    inputSummary: unknown;
    paths: string[];
  }>;

  toolResults: Array<{
    name: string;
    isError: boolean;
    exitCode: number | null;
    excerpt: string;
    truncated: boolean;
  }>;

  progress: {
    continuationIndex: number;
    noProgressCount: number;
    verificationSucceeded: boolean;
    expectedArtifactsPresent: boolean | null;
  };

  deterministicReasonCodes: string[];
}
```

The classifier predicts the reasoning required by the next provider request. Tool names and success metadata are evidence, not direct weak-approval rules.

## Input Budget and Redaction

Add one optional configuration field while retaining config `version: 1`:

```json
{
  "classification": {
    "maxContinuationResultChars": 6000
  }
}
```

Rules:

- default total tool-result excerpt budget: 6000 characters;
- maximum excerpt from one tool result: 2000 characters;
- independently bound original prompt and recent assistant text;
- preserve tool state, error codes, and path summaries before prose excerpts;
- ensure the final serialized classifier input does not exceed `classification.maxInputChars`;
- trim excerpts by deterministic priority instead of treating oversized evidence as permanent user routing.

Before sending excerpts, redact common secret forms:

- Authorization and Bearer tokens;
- API keys and access tokens;
- PEM private keys;
- common cloud credentials;
- `.env`-style secret/password/token assignments;
- suspicious high-entropy long strings.

Heuristic redaction is not an absolute secrecy guarantee. Excerpts are sent only to the explicitly configured classifier provider, are aggressively bounded, and are never stored in audit logs.

## Model Transition Semantics

### Active mode

```text
route=user:
  current == requestUserModel → no-op
  current is weak             → setModel(requestUserModel)

route=weak:
  current == selected weak    → no-op
  otherwise                   → resolve weak pool and setModel(selected weak)
```

Every continuation may independently produce:

```text
user → weak → user → weak
```

No minimum lease or sticky state is added.

### Weak-pool failure

- Cool and skip weak candidates that fail resolution, auth, capability, or `setModel`.
- Try the next configured weak candidate within existing pool semantics.
- If the pool is exhausted, keep or restore `requestUserModel`.
- The router may become suspended, but the ordinary agent run continues on the user model.

### Classifier failure

- Current model is user model: keep it.
- Current model is weak: restore `requestUserModel`.
- Existing classifier pool fallback and cooldown rules remain.
- Pool exhaustion suspends routing until normal retry recovery.
- User abort does not cool candidates.

### Provider failure and completion

- Weak provider error: cool the actual weak model and restore the user model.
- User-model provider error: expose Pi's normal error; the router selects no alternative.
- Abort: restore the user model without cooling it.
- Agent completion: restore the user model if a weak lease remains.
- Restore failure: report `restore-error`; do not select another model.
- Before a new user prompt, finish restoring the previous run before capturing the new run's user model.

## Shadow Mode

Shadow mode performs the same continuation safety gate, classification, readiness, and recommendation logic, but never calls `pi.setModel()`.

Each continuation audit record contains its own classification and recommended route. It must not copy the initial classification. Shadow data can therefore measure continuation downgrade opportunity, though it cannot directly measure counterfactual weak-model quality without replay or active experiments.

## Audit Schema Version 2

New records use:

```text
schemaVersion: 2
```

They include:

- `route: user | weak | reject`;
- decision kind;
- independent classifier identity, fallback count, latency, and result;
- classifier input character count;
- result excerpt character count;
- whether excerpts were truncated;
- recommended and actual model identities;
- existing allowlisted usage and tool-summary fields.

They never include prompt text, assistant text, tool-result text, excerpts, redacted values, auth, headers, or environment variables.

`shadow-review` must accept both schemas. Legacy schema 1 `strong` means legacy `user/no-downgrade`; historical files are not rewritten.

## Compatibility

- Configuration version remains 1.
- `maxContinuationResultChars` is optional with a default of 6000.
- Unknown fields and invalid ranges remain strict errors.
- Existing health files require no migration.
- Existing schema 1 audit logs remain readable.
- Pi core and its public extension API remain unchanged.

## Testing Strategy

Implementation follows red-green-refactor. Tests must first fail for missing continuation behavior before production code changes.

### Continuation classification

1. Initial user route followed by a successful tool batch invokes the continuation classifier.
2. A weak continuation decision switches before the next provider request.
3. A user decision restores the exact `requestUserModel` object.
4. `user → weak → user → weak` is permitted.
5. Each continuation stores a fresh classifier result.
6. A no-tool completion does not classify.

### Safety gate

7. Tool error and nonzero exit skip classification and restore user.
8. A later successful batch can classify again.
9. Missing initial capsule does not suppress continuation classification.
10. Confirmed scope drift routes user without classifier.
11. Weak context-window insufficiency routes user.

### Input and privacy

12. Classifier receives bounded result excerpts.
13. Per-tool and total budgets apply.
14. Authorization, API key, PEM, and `.env` secrets are redacted.
15. Final serialized input stays within `maxInputChars`.
16. Audit output contains no excerpt, prompt, or secret marker.

### Failure recovery

17. Classifier failure while on user model causes no switch.
18. Classifier failure while on weak restores user.
19. Weak-pool exhaustion restores or keeps user.
20. User-model provider errors trigger no alternate model.
21. Agent end and the next user request restore the exact user model.

### Shadow and compatibility

22. Every eligible shadow continuation invokes the classifier.
23. Shadow mode makes zero `setModel` calls.
24. Continuation logs contain independent decisions with schema version 2.
25. Shadow review distinguishes legacy and new records.
26. Legacy config parses with the new default.

## Documentation Updates

Update `docs/pi-model-routing-design.md` to make provider-request routing the durable architecture, remove inaccurate strong/upgrade language, document classifier excerpts and privacy boundaries, describe no-hysteresis transitions, and update the failure and audit matrices.

Update example configuration only to show the new optional result budget.

## Known Trade-offs

- Eligible continuation requests incur classifier latency and cost.
- Frequent provider changes can reduce prompt-cache efficiency.
- A weak model may need to ingest a large context for its first request.
- Pi's `setModel()` persists model-change/default-selection side effects; the extension mitigates this by restoring the exact user model.
- Cross-provider normalized history is supported by Pi, but candidate-specific compatibility still needs testing.
- Shadow decisions measure recommendation frequency, not counterfactual weak output quality.

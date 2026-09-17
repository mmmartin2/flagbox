# flagbox

A feature flag library for side projects that don't need a hosted flags
service. Flags live in a JSON file next to your code (or wherever you point
it), and evaluation is a plain function call - no network request, no
account, no monthly bill.

## Why

Most feature flag tools assume you're paying for a SaaS dashboard. For a
personal project or a small internal tool that's overkill: you just want to
turn something on for yourself, roll it out to a percentage of users, and
flip it off if it breaks. `flagbox` does that with a file and a hash
function.

Rollouts are bucketed deterministically: a user's bucket for a given flag is
`sha256(flagKey + ":" + userId) mod 100`, so the same user always lands in
the same bucket. That means you can raise a rollout from 10% to 50% without
reshuffling who already has the flag turned on.

## Library usage

```ts
import { evaluate, type FlagDefinition } from "flagbox";

const newCheckout: FlagDefinition = {
  key: "new-checkout",
  enabled: true,
  rollout: 25,
  rules: [{ attribute: "plan", equals: "internal" }],
};

evaluate(newCheckout, { id: "user-42" });
// -> true for ~25% of ids, always true for anyone with plan=internal

evaluate(newCheckout, { id: "user-42", attributes: { plan: "internal" } });
// -> true, rule matched regardless of rollout bucket
```

Flags aren't limited to on/off. Give a flag `variants` and use `evaluateVariant`
to pick one of several string values, weighted by percentage and bucketed the
same deterministic way as rollout:

```ts
import { evaluateVariant, type FlagDefinition } from "flagbox";

const buttonColor: FlagDefinition = {
  key: "button-color",
  enabled: true,
  variants: [
    { value: "blue", weight: 50 },
    { value: "green", weight: 30 },
    { value: "red", weight: 20 },
  ],
};

evaluateVariant(buttonColor, { id: "user-42" });
// -> "blue" | "green" | "red", weighted by the percentages above
// -> undefined if the flag is off, has no rules/rollout match, or has no variants
```

The variant bucket is seeded separately from the rollout bucket, so a flag's
on/off split and its variant split don't correlate.

For persistence, use `FlagStore`, which reads and writes a JSON file:

```ts
import { FlagStore } from "flagbox";

const store = new FlagStore("flags.json");
store.upsert({ key: "dark-mode", enabled: true, rollout: 100 });
store.evaluate("dark-mode", { id: "user-42" });
```

## CLI usage

```
flagbox add new-checkout --rollout 25
flagbox rule new-checkout plan internal
flagbox add button-color
flagbox variant button-color blue 50
flagbox variant button-color green 50
flagbox list
flagbox eval new-checkout --user user-42
flagbox eval new-checkout --user user-7 --attr plan=internal
flagbox eval button-color --user user-42
flagbox off new-checkout
```

The CLI reads and writes `flags.json` in the current directory by default;
set `FLAGBOX_FILE` to point somewhere else.

## Building

```
npm install --no-save typescript
npx tsc
node dist/cli.js list
```

There's nothing else in the dependency tree - the compiler is the only
tool involved, and it's only needed to build, not to run the compiled
output.

## Status

Early skeleton: boolean flags, variant/multivalue flags, percentage rollout,
and simple attribute rules work. No watch mode for the JSON file yet, no
schema validation on load.

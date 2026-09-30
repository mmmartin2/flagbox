import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  bucketOf,
  evaluate,
  evaluateVariant,
  FlagStore,
  validateFlags,
  type FlagDefinition,
} from "./flags.js";

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `user-${i}`);
}

describe("bucketOf", () => {
  it("always returns an integer from 0 to 99", () => {
    for (const id of ids(2000)) {
      const bucket = bucketOf("f", id);
      assert.ok(Number.isInteger(bucket));
      assert.ok(bucket >= 0 && bucket <= 99, `bucket ${bucket} out of range`);
    }
  });

  it("is stable for the same flag and id", () => {
    assert.equal(bucketOf("checkout", "user-1"), bucketOf("checkout", "user-1"));
  });

  it("spreads ids roughly evenly across buckets", () => {
    const total = 20000;
    const counts = new Array<number>(100).fill(0);
    for (const id of ids(total)) counts[bucketOf("spread", id)]++;

    const expected = total / 100;
    for (const [bucket, count] of counts.entries()) {
      // about 5.7 standard deviations, so a fair hash will not trip this
      assert.ok(Math.abs(count - expected) < 80, `bucket ${bucket} has ${count}, expected near ${expected}`);
    }
  });

  it("buckets the same id differently for different flags", () => {
    const differing = ids(500).filter((id) => bucketOf("flag-a", id) !== bucketOf("flag-b", id));
    // identical bucketing would mean one flag's rollout always mirrors another's
    assert.ok(differing.length > 400);
  });

  it("changes the bucket when a salt is given", () => {
    const differing = ids(500).filter((id) => bucketOf("f", id) !== bucketOf("f", id, ":variant"));
    assert.ok(differing.length > 400);
  });
});

describe("evaluate", () => {
  const base: FlagDefinition = { key: "new-checkout", enabled: true };

  it("is off for everyone when disabled, even with a matching rule", () => {
    const flag: FlagDefinition = {
      ...base,
      enabled: false,
      rules: [{ attribute: "plan", equals: "internal" }],
    };
    assert.equal(evaluate(flag, { id: "u", attributes: { plan: "internal" } }), false);
  });

  it("is on for everyone when there is no rollout", () => {
    for (const id of ids(50)) assert.equal(evaluate(base, { id }), true);
  });

  it("treats rollout 0 as off and 100 as on", () => {
    for (const id of ids(200)) {
      assert.equal(evaluate({ ...base, rollout: 0 }, { id }), false);
      assert.equal(evaluate({ ...base, rollout: 100 }, { id }), true);
    }
  });

  it("turns on roughly the requested share of ids", () => {
    const total = 10000;
    const flag = { ...base, rollout: 25 };
    const on = ids(total).filter((id) => evaluate(flag, { id })).length;
    assert.ok(Math.abs(on / total - 0.25) < 0.03, `${on} of ${total} were on`);
  });

  it("keeps everyone already on when the rollout is raised", () => {
    const at10 = ids(3000).filter((id) => evaluate({ ...base, rollout: 10 }, { id }));
    assert.ok(at10.length > 0);
    for (const id of at10) assert.equal(evaluate({ ...base, rollout: 50 }, { id }), true);
  });

  it("lets a matching rule bypass a zero rollout", () => {
    const flag: FlagDefinition = {
      ...base,
      rollout: 0,
      rules: [{ attribute: "plan", equals: "internal" }],
    };
    assert.equal(evaluate(flag, { id: "u", attributes: { plan: "internal" } }), true);
  });

  it("falls back to rollout when no rule matches", () => {
    const flag: FlagDefinition = {
      ...base,
      rollout: 0,
      rules: [{ attribute: "plan", equals: "internal" }],
    };
    assert.equal(evaluate(flag, { id: "u", attributes: { plan: "free" } }), false);
    assert.equal(evaluate(flag, { id: "u", attributes: {} }), false);
    assert.equal(evaluate(flag, { id: "u" }), false);
  });

  it("matches when any one of several rules matches", () => {
    const flag: FlagDefinition = {
      ...base,
      rollout: 0,
      rules: [
        { attribute: "plan", equals: "internal" },
        { attribute: "country", equals: "NZ" },
      ],
    };
    assert.equal(evaluate(flag, { id: "u", attributes: { country: "NZ" } }), true);
  });

  it("compares attribute values exactly", () => {
    const flag: FlagDefinition = {
      ...base,
      rollout: 0,
      rules: [{ attribute: "plan", equals: "internal" }],
    };
    assert.equal(evaluate(flag, { id: "u", attributes: { plan: "Internal" } }), false);
  });
});

describe("evaluateVariant", () => {
  const variants = [
    { value: "blue", weight: 50 },
    { value: "green", weight: 30 },
    { value: "red", weight: 20 },
  ];
  const flag: FlagDefinition = { key: "button-color", enabled: true, variants };

  it("returns undefined for flags without variants", () => {
    assert.equal(evaluateVariant({ key: "k", enabled: true }, { id: "u" }), undefined);
    assert.equal(evaluateVariant({ key: "k", enabled: true, variants: [] }, { id: "u" }), undefined);
  });

  it("returns undefined when the flag is off", () => {
    assert.equal(evaluateVariant({ ...flag, enabled: false }, { id: "u" }), undefined);
    assert.equal(evaluateVariant({ ...flag, rollout: 0 }, { id: "u" }), undefined);
  });

  it("gives the same id the same variant every time", () => {
    assert.equal(evaluateVariant(flag, { id: "user-9" }), evaluateVariant(flag, { id: "user-9" }));
  });

  it("splits ids according to the weights", () => {
    const total = 10000;
    const counts: Record<string, number> = { blue: 0, green: 0, red: 0 };
    for (const id of ids(total)) counts[evaluateVariant(flag, { id })!]++;

    assert.ok(Math.abs(counts.blue / total - 0.5) < 0.03, `blue: ${counts.blue}`);
    assert.ok(Math.abs(counts.green / total - 0.3) < 0.03, `green: ${counts.green}`);
    assert.ok(Math.abs(counts.red / total - 0.2) < 0.03, `red: ${counts.red}`);
  });

  it("returns undefined for ids past the end of under-weighted variants", () => {
    const partial: FlagDefinition = { key: "partial", enabled: true, variants: [{ value: "only", weight: 40 }] };
    const results = ids(2000).map((id) => evaluateVariant(partial, { id }));
    assert.ok(results.includes("only"));
    assert.ok(results.includes(undefined));
  });

  it("does not tie the variant to the rollout bucket", () => {
    // if both used one bucket, everyone inside a 50% rollout would land in the
    // lower half of the variant range and never see the second variant
    const half: FlagDefinition = {
      key: "half",
      enabled: true,
      rollout: 50,
      variants: [
        { value: "a", weight: 50 },
        { value: "b", weight: 50 },
      ],
    };
    const seen = new Set(ids(1000).map((id) => evaluateVariant(half, { id })));
    assert.ok(seen.has("a") && seen.has("b"));
  });
});

describe("validateFlags", () => {
  it("accepts a well-formed file", () => {
    const flags = [
      { key: "a", enabled: true, rollout: 50, rules: [{ attribute: "plan", equals: "x" }], description: "d" },
      { key: "b", enabled: false, variants: [{ value: "v", weight: 100 }] },
    ];
    assert.deepEqual(validateFlags(flags), []);
  });

  it("rejects a non-array top level", () => {
    assert.equal(validateFlags({ key: "a" }).length, 1);
    assert.equal(validateFlags(null).length, 1);
  });

  it("reports every problem, not just the first", () => {
    const errors = validateFlags([
      { key: "", enabled: "yes" },
      { key: "dup", enabled: true },
      { key: "dup", enabled: true, rollout: 150 },
      "nope",
    ]);
    assert.equal(errors.length, 5);
    assert.ok(errors.some((e) => e.includes("duplicate key")));
    assert.ok(errors.some((e) => e.includes("rollout")));
  });

  it("rejects malformed rules and variants", () => {
    const errors = validateFlags([
      {
        key: "a",
        enabled: true,
        rules: [{ attribute: "plan" }],
        variants: [{ value: "v", weight: -1 }],
      },
    ]);
    assert.equal(errors.length, 2);
  });
});

describe("FlagStore", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flagbox-test-"));
    path = join(dir, "flags.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty when the file does not exist", () => {
    assert.deepEqual(new FlagStore(path).list(), []);
  });

  it("starts empty when the file is blank", () => {
    writeFileSync(path, "  \n");
    assert.deepEqual(new FlagStore(path).list(), []);
  });

  it("persists upserts and reloads them", () => {
    const store = new FlagStore(path);
    store.upsert({ key: "b", enabled: true, rollout: 10 });
    store.upsert({ key: "a", enabled: false });

    const reloaded = new FlagStore(path);
    assert.deepEqual(
      reloaded.list().map((f) => f.key),
      ["a", "b"],
    );
    assert.equal(reloaded.get("b")?.rollout, 10);
  });

  it("removes flags and reports whether one existed", () => {
    const store = new FlagStore(path);
    store.upsert({ key: "a", enabled: true });
    assert.equal(store.remove("a"), true);
    assert.equal(store.remove("a"), false);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), []);
  });

  it("throws on unknown flag keys", () => {
    const store = new FlagStore(path);
    assert.throws(() => store.evaluate("missing", { id: "u" }), /unknown flag: missing/);
    assert.throws(() => store.evaluateVariant("missing", { id: "u" }), /unknown flag: missing/);
  });

  it("refuses to load invalid JSON", () => {
    writeFileSync(path, "{not json");
    assert.throws(() => new FlagStore(path), /not valid JSON/);
  });

  it("refuses to load a file with invalid flags", () => {
    writeFileSync(path, JSON.stringify([{ key: "a", enabled: "yes" }]));
    assert.throws(() => new FlagStore(path), /invalid flag definition/);
  });
});

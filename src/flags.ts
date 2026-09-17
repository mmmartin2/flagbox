import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface FlagRule {
  attribute: string;
  equals: string;
}

export interface FlagVariant {
  value: string;
  /** percent of ids that get this variant, 0-100. a flag's variant weights should add up to 100. */
  weight: number;
}

export interface FlagDefinition {
  key: string;
  enabled: boolean;
  /** percent of ids that see the flag as on, 0-100. omitted means everyone (subject to enabled/rules). */
  rollout?: number;
  /** any matching rule forces the flag on, bypassing rollout. used for beta testers, internal accounts, etc. */
  rules?: FlagRule[];
  /** when set, evaluateVariant() picks one of these instead of a plain boolean. */
  variants?: FlagVariant[];
  description?: string;
}

export interface EvalContext {
  id: string;
  attributes?: Record<string, string>;
}

/**
 * Buckets an id into 0-99 deterministically per flag, so the same id always
 * lands in the same bucket for a given flag key and a rollout percentage can
 * grow over time without reshuffling who already has the flag.
 */
export function bucketOf(flagKey: string, id: string, salt = ""): number {
  const digest = createHash("sha256").update(`${flagKey}${salt}:${id}`).digest();
  return digest.readUInt32BE(0) % 100;
}

/**
 * Picks a variant using a bucket seeded separately from the rollout bucket,
 * so a flag's on/off rollout and its variant split don't correlate (e.g. the
 * first 10% to get the flag turned on aren't also always the first variant).
 */
function pickVariant(variants: FlagVariant[], flagKey: string, id: string): string | undefined {
  const bucket = bucketOf(flagKey, id, ":variant");
  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.weight;
    if (bucket < cumulative) return variant.value;
  }
  return undefined;
}

function rulesMatch(rules: FlagRule[], context: EvalContext): boolean {
  if (!context.attributes) return false;
  return rules.some((rule) => context.attributes![rule.attribute] === rule.equals);
}

export function evaluate(flag: FlagDefinition, context: EvalContext): boolean {
  if (!flag.enabled) return false;
  if (flag.rules && rulesMatch(flag.rules, context)) return true;

  if (flag.rollout === undefined || flag.rollout >= 100) return true;
  if (flag.rollout <= 0) return false;

  return bucketOf(flag.key, context.id) < flag.rollout;
}

/**
 * Like evaluate(), but for flags with variants: returns the assigned
 * variant's value, or undefined if the flag is off or has no variants.
 */
export function evaluateVariant(flag: FlagDefinition, context: EvalContext): string | undefined {
  if (!flag.variants || flag.variants.length === 0) return undefined;
  if (!evaluate(flag, context)) return undefined;
  return pickVariant(flag.variants, flag.key, context.id);
}

export class FlagStore {
  private flags = new Map<string, FlagDefinition>();

  constructor(private path: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const raw = readFileSync(this.path, "utf8");
    const parsed: FlagDefinition[] = raw.trim() === "" ? [] : JSON.parse(raw);
    for (const flag of parsed) this.flags.set(flag.key, flag);
  }

  private save(): void {
    const all = [...this.flags.values()].sort((a, b) => a.key.localeCompare(b.key));
    writeFileSync(this.path, JSON.stringify(all, null, 2) + "\n", "utf8");
  }

  list(): FlagDefinition[] {
    return [...this.flags.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  get(key: string): FlagDefinition | undefined {
    return this.flags.get(key);
  }

  upsert(flag: FlagDefinition): void {
    this.flags.set(flag.key, flag);
    this.save();
  }

  remove(key: string): boolean {
    const removed = this.flags.delete(key);
    if (removed) this.save();
    return removed;
  }

  evaluate(key: string, context: EvalContext): boolean {
    const flag = this.flags.get(key);
    if (!flag) throw new Error(`unknown flag: ${key}`);
    return evaluate(flag, context);
  }

  evaluateVariant(key: string, context: EvalContext): string | undefined {
    const flag = this.flags.get(key);
    if (!flag) throw new Error(`unknown flag: ${key}`);
    return evaluateVariant(flag, context);
  }
}

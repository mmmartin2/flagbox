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

/**
 * Checks that a parsed flags.json value actually looks like an array of
 * FlagDefinitions, and returns every problem found rather than bailing on
 * the first one - a file edited by hand often has more than one mistake.
 */
export function validateFlags(parsed: unknown): string[] {
  const errors: string[] = [];

  if (!Array.isArray(parsed)) {
    return [`expected an array of flags at the top level, got ${typeof parsed}`];
  }

  const seenKeys = new Set<string>();

  parsed.forEach((flag, index) => {
    const where = `flag[${index}]${isRecord(flag) && typeof flag.key === "string" ? ` (${flag.key})` : ""}`;

    if (!isRecord(flag)) {
      errors.push(`${where}: expected an object, got ${typeof flag}`);
      return;
    }

    if (typeof flag.key !== "string" || flag.key === "") {
      errors.push(`${where}: "key" must be a non-empty string`);
    } else if (seenKeys.has(flag.key)) {
      errors.push(`${where}: duplicate key "${flag.key}"`);
    } else {
      seenKeys.add(flag.key);
    }

    if (typeof flag.enabled !== "boolean") {
      errors.push(`${where}: "enabled" must be a boolean`);
    }

    if (flag.rollout !== undefined && !isPercent(flag.rollout)) {
      errors.push(`${where}: "rollout" must be a number between 0 and 100`);
    }

    if (flag.description !== undefined && typeof flag.description !== "string") {
      errors.push(`${where}: "description" must be a string`);
    }

    if (flag.rules !== undefined) {
      if (!Array.isArray(flag.rules)) {
        errors.push(`${where}: "rules" must be an array`);
      } else {
        flag.rules.forEach((rule, ruleIndex) => {
          if (!isRecord(rule) || typeof rule.attribute !== "string" || typeof rule.equals !== "string") {
            errors.push(`${where}: rule[${ruleIndex}] must have string "attribute" and "equals"`);
          }
        });
      }
    }

    if (flag.variants !== undefined) {
      if (!Array.isArray(flag.variants)) {
        errors.push(`${where}: "variants" must be an array`);
      } else {
        flag.variants.forEach((variant, variantIndex) => {
          if (!isRecord(variant) || typeof variant.value !== "string" || !isPercent(variant.weight)) {
            errors.push(
              `${where}: variant[${variantIndex}] must have a string "value" and a "weight" between 0 and 100`,
            );
          }
        });
      }
    }
  });

  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

export class FlagStore {
  private flags = new Map<string, FlagDefinition>();

  constructor(private path: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const raw = readFileSync(this.path, "utf8");
    if (raw.trim() === "") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`${this.path} is not valid JSON: ${reason}`);
    }

    const errors = validateFlags(parsed);
    if (errors.length > 0) {
      throw new Error(`${this.path} has an invalid flag definition:\n  ${errors.join("\n  ")}`);
    }

    for (const flag of parsed as FlagDefinition[]) this.flags.set(flag.key, flag);
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

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface FlagRule {
  attribute: string;
  equals: string;
}

export interface FlagDefinition {
  key: string;
  enabled: boolean;
  /** percent of ids that see the flag as on, 0-100. omitted means everyone (subject to enabled/rules). */
  rollout?: number;
  /** any matching rule forces the flag on, bypassing rollout. used for beta testers, internal accounts, etc. */
  rules?: FlagRule[];
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
export function bucketOf(flagKey: string, id: string): number {
  const digest = createHash("sha256").update(`${flagKey}:${id}`).digest();
  return digest.readUInt32BE(0) % 100;
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
}

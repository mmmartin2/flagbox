#!/usr/bin/env node
import { FlagStore, type EvalContext, type FlagRule, type FlagVariant } from "./flags.js";

const STORE_PATH = process.env.FLAGBOX_FILE ?? "flags.json";

function usage(): void {
  console.log(`flagbox - local feature flags

Usage:
  flagbox list
  flagbox add <key> [--rollout <0-100>] [--desc <text>]
  flagbox on <key>
  flagbox off <key>
  flagbox rollout <key> <0-100>
  flagbox rule <key> <attribute> <value>
  flagbox variant <key> <value> <weight 0-100>
  flagbox rm <key>
  flagbox eval <key> --user <id> [--attr key=value ...]

Add --json to any command to get machine-readable output instead of text.

Flags are stored in ${STORE_PATH} (override with FLAGBOX_FILE).`);
}

// flags that don't take a value - everything else consumes the next arg
const BOOLEAN_OPTS = new Set(["json"]);

function parseFlags(args: string[]): { positional: string[]; opts: Record<string, string[]> } {
  const positional: string[] = [];
  const opts: Record<string, string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const value = BOOLEAN_OPTS.has(name) ? "true" : (args[++i] ?? "");
      (opts[name] ??= []).push(value);
    } else {
      positional.push(arg);
    }
  }
  return { positional, opts };
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const store = new FlagStore(STORE_PATH);
  const { positional, opts } = parseFlags(rest);
  const json = opts.json?.[0] === "true";

  switch (command) {
    case "list": {
      const flags = store.list();
      if (json) {
        console.log(JSON.stringify(flags, null, 2));
        return;
      }
      if (flags.length === 0) {
        console.log("no flags defined");
        return;
      }
      for (const flag of flags) {
        const parts = [flag.enabled ? "on " : "off"];
        if (flag.rollout !== undefined) parts.push(`rollout=${flag.rollout}%`);
        if (flag.rules?.length) parts.push(`rules=${flag.rules.length}`);
        if (flag.variants?.length) {
          parts.push(`variants=${flag.variants.map((v) => `${v.value}:${v.weight}%`).join(",")}`);
        }
        console.log(`${flag.key.padEnd(24)} ${parts.join(" ")}`);
      }
      return;
    }

    case "add": {
      const key = positional[0];
      if (!key) return fail("add requires a key", json);
      const rolloutRaw = opts.rollout?.[0];
      const flag = {
        key,
        enabled: true,
        rollout: rolloutRaw === undefined ? undefined : Number(rolloutRaw),
        description: opts.desc?.[0],
      };
      store.upsert(flag);
      if (json) console.log(JSON.stringify(flag));
      else console.log(`added ${key}`);
      return;
    }

    case "on":
    case "off": {
      const key = positional[0];
      if (!key) return fail(`${command} requires a key`, json);
      const flag = store.get(key);
      if (!flag) return fail(`unknown flag: ${key}`, json);
      flag.enabled = command === "on";
      store.upsert(flag);
      if (json) console.log(JSON.stringify({ key, enabled: flag.enabled }));
      else console.log(`${key} is now ${flag.enabled ? "on" : "off"}`);
      return;
    }

    case "rollout": {
      const [key, percentRaw] = positional;
      if (!key || percentRaw === undefined) return fail("rollout requires a key and a percentage", json);
      const flag = store.get(key);
      if (!flag) return fail(`unknown flag: ${key}`, json);
      flag.rollout = Number(percentRaw);
      store.upsert(flag);
      if (json) console.log(JSON.stringify({ key, rollout: flag.rollout }));
      else console.log(`${key} rollout set to ${flag.rollout}%`);
      return;
    }

    case "rule": {
      const [key, attribute, value] = positional;
      if (!key || !attribute || value === undefined) {
        return fail("rule requires a key, attribute, and value", json);
      }
      const flag = store.get(key);
      if (!flag) return fail(`unknown flag: ${key}`, json);
      const rule: FlagRule = { attribute, equals: value };
      flag.rules = [...(flag.rules ?? []), rule];
      store.upsert(flag);
      if (json) console.log(JSON.stringify({ key, rule }));
      else console.log(`added rule to ${key}: ${attribute}=${value}`);
      return;
    }

    case "variant": {
      const [key, value, weightRaw] = positional;
      if (!key || !value || weightRaw === undefined) {
        return fail("variant requires a key, a value, and a weight", json);
      }
      const flag = store.get(key);
      if (!flag) return fail(`unknown flag: ${key}`, json);
      const weight = Number(weightRaw);
      if (!Number.isFinite(weight) || weight < 0 || weight > 100) {
        return fail("weight must be a number between 0 and 100", json);
      }
      const variant: FlagVariant = { value, weight };
      flag.variants = [...(flag.variants ?? []).filter((v) => v.value !== value), variant];
      store.upsert(flag);
      if (json) console.log(JSON.stringify({ key, variant }));
      else console.log(`added variant to ${key}: ${value}=${weight}%`);
      return;
    }

    case "rm": {
      const key = positional[0];
      if (!key) return fail("rm requires a key", json);
      const removed = store.remove(key);
      if (json) console.log(JSON.stringify({ key, removed }));
      else console.log(removed ? `removed ${key}` : `unknown flag: ${key}`);
      return;
    }

    case "eval": {
      const key = positional[0];
      const user = opts.user?.[0];
      if (!key || !user) return fail("eval requires a key and --user <id>", json);
      const attributes: Record<string, string> = {};
      for (const pair of opts.attr ?? []) {
        const [attrKey, attrValue] = pair.split("=");
        if (attrKey && attrValue !== undefined) attributes[attrKey] = attrValue;
      }
      const context: EvalContext = { id: user, attributes };
      const flag = store.get(key);
      const result = flag?.variants?.length
        ? (store.evaluateVariant(key, context) ?? null)
        : store.evaluate(key, context);
      if (json) console.log(JSON.stringify({ key, user, result }));
      else console.log(result === null ? "false" : result);
      return;
    }

    default:
      usage();
      if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
}

function fail(message: string, json = false): void {
  if (json) console.error(JSON.stringify({ error: message }));
  else console.error(`error: ${message}`);
  process.exitCode = 1;
}

main();

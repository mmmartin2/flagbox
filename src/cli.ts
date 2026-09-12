#!/usr/bin/env node
import { FlagStore, type EvalContext, type FlagRule } from "./flags.js";

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
  flagbox rm <key>
  flagbox eval <key> --user <id> [--attr key=value ...]

Flags are stored in ${STORE_PATH} (override with FLAGBOX_FILE).`);
}

function parseFlags(args: string[]): { positional: string[]; opts: Record<string, string[]> } {
  const positional: string[] = [];
  const opts: Record<string, string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const value = args[++i] ?? "";
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

  switch (command) {
    case "list": {
      const flags = store.list();
      if (flags.length === 0) {
        console.log("no flags defined");
        return;
      }
      for (const flag of flags) {
        const parts = [flag.enabled ? "on " : "off"];
        if (flag.rollout !== undefined) parts.push(`rollout=${flag.rollout}%`);
        if (flag.rules?.length) parts.push(`rules=${flag.rules.length}`);
        console.log(`${flag.key.padEnd(24)} ${parts.join(" ")}`);
      }
      return;
    }

    case "add": {
      const key = positional[0];
      if (!key) return fail("add requires a key");
      const rolloutRaw = opts.rollout?.[0];
      store.upsert({
        key,
        enabled: true,
        rollout: rolloutRaw === undefined ? undefined : Number(rolloutRaw),
        description: opts.desc?.[0],
      });
      console.log(`added ${key}`);
      return;
    }

    case "on":
    case "off": {
      const key = positional[0];
      if (!key) return fail(`${command} requires a key`);
      const flag = store.get(key);
      if (!flag) return fail(`unknown flag: ${key}`);
      flag.enabled = command === "on";
      store.upsert(flag);
      console.log(`${key} is now ${flag.enabled ? "on" : "off"}`);
      return;
    }

    case "rollout": {
      const [key, percentRaw] = positional;
      if (!key || percentRaw === undefined) return fail("rollout requires a key and a percentage");
      const flag = store.get(key);
      if (!flag) return fail(`unknown flag: ${key}`);
      flag.rollout = Number(percentRaw);
      store.upsert(flag);
      console.log(`${key} rollout set to ${flag.rollout}%`);
      return;
    }

    case "rule": {
      const [key, attribute, value] = positional;
      if (!key || !attribute || value === undefined) return fail("rule requires a key, attribute, and value");
      const flag = store.get(key);
      if (!flag) return fail(`unknown flag: ${key}`);
      const rule: FlagRule = { attribute, equals: value };
      flag.rules = [...(flag.rules ?? []), rule];
      store.upsert(flag);
      console.log(`added rule to ${key}: ${attribute}=${value}`);
      return;
    }

    case "rm": {
      const key = positional[0];
      if (!key) return fail("rm requires a key");
      console.log(store.remove(key) ? `removed ${key}` : `unknown flag: ${key}`);
      return;
    }

    case "eval": {
      const key = positional[0];
      const user = opts.user?.[0];
      if (!key || !user) return fail("eval requires a key and --user <id>");
      const attributes: Record<string, string> = {};
      for (const pair of opts.attr ?? []) {
        const [attrKey, attrValue] = pair.split("=");
        if (attrKey && attrValue !== undefined) attributes[attrKey] = attrValue;
      }
      const context: EvalContext = { id: user, attributes };
      console.log(store.evaluate(key, context));
      return;
    }

    default:
      usage();
      if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
}

function fail(message: string): void {
  console.error(`error: ${message}`);
  process.exitCode = 1;
}

main();

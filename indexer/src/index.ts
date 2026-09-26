// Store every event of every contract in the generic `event` table.
import { ponder } from "ponder:registry";
import { event } from "ponder:schema";
import config from "../ponder.config";

const encode = (v: unknown): unknown =>
  typeof v === "bigint"
    ? { $b: v.toString() }
    : Array.isArray(v)
      ? v.map(encode)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]))
        : v;

const NAMES: Record<string, string> = { Token: "token", Market: "market", Pool: "pool" };

for (const [contractName, contract] of Object.entries(config.contracts)) {
  for (const item of contract.abi as readonly { type: string; name?: string }[]) {
    if (item.type !== "event" || !item.name) continue;
    // @ts-expect-error event names are generated from the ABI at runtime
    ponder.on(`${contractName}:${item.name}`, async ({ event: ev, context }) => {
      await context.db
        .insert(event)
        .values({
          id: `${ev.block.number}-${ev.log.logIndex}`,
          contract: NAMES[contractName] ?? contractName.toLowerCase(),
          name: item.name!,
          block: ev.block.number,
          logIndex: ev.log.logIndex,
          tx: ev.transaction.hash,
          args: encode(ev.args) as object,
        })
        .onConflictDoNothing();
    });
  }
}

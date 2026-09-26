import { index, onchainTable } from "ponder";

/**
 * One generic row per contract event. `args` keeps the decoded event arguments with bigints encoded as
 * { "$b": "123" } — exactly the format the web app's in-browser indexer caches, so the UI code is shared.
 */
export const event = onchainTable(
  "event",
  (t) => ({
    id: t.text().primaryKey(), // `${block}-${logIndex}`
    contract: t.text().notNull(), // "token" | "market" | "pool"
    name: t.text().notNull(), // event name, e.g. "BlockMined"
    block: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    tx: t.hex().notNull(),
    args: t.json().notNull(),
  }),
  (table) => ({ byContractBlock: index().on(table.contract, table.block) })
);

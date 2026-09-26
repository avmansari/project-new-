// HTTP API used by the web app when VITE_INDEXER_URL is set.
//   GET /events?contract=token|market|pool&after=<block>   -> events with block > after (max 5,000 per call)
//   GET /graphql                                            -> Ponder GraphQL explorer
//   GET /health, /ready, /status                            -> built into Ponder
import { db } from "ponder:api";
import schema from "ponder:schema";
import { and, asc, eq, gt, graphql } from "ponder";
import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono();
app.use("*", cors({ origin: process.env.CORS_ORIGIN?.split(",") ?? "*" }));
app.use("/graphql", graphql({ db, schema }));

app.get("/events", async (c) => {
  const contract = c.req.query("contract") ?? "token";
  const after = BigInt(c.req.query("after") ?? "-1");
  const rows = await db
    .select()
    .from(schema.event)
    .where(and(eq(schema.event.contract, contract), gt(schema.event.block, after)))
    .orderBy(asc(schema.event.block), asc(schema.event.logIndex))
    .limit(5000);
  const events = rows.map((r) => ({ event: r.name, args: r.args, block: { $b: r.block.toString() }, tx: r.tx, logIndex: r.logIndex }));
  c.header("Cache-Control", "no-store");
  return c.json({ events, more: rows.length === 5000 });
});

export default app;

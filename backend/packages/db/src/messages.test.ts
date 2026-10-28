import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb, type Db } from "./client.js";
import { runMigrations } from "./migrations.js";
import { ensureUser, saveMessage, listHistory, getUserByPhone } from "./repos.js";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set — skipping DB integration test";

let db: Db | null = null;
let userId = "";
const phone = `test-${randomUUID().slice(0, 12)}`;

function getDb(): Db {
  if (!db) throw new Error("database not initialised");
  return db;
}

before(async () => {
  if (!url) return;
  db = createDb(url, { max: 2 });
  await runMigrations(db);
  const user = await ensureUser(db, { phone, timezone: "Africa/Lagos" });
  userId = user.id;
});

after(async () => {
  if (!db) return;
  if (userId) await db`delete from users where id = ${userId}`;
  await db.end();
});

test("ensureUser is idempotent", { skip }, async () => {
  const d = getDb();
  const a = await ensureUser(d, { phone, timezone: "Europe/London" });
  const b = await ensureUser(d, { phone, timezone: "Europe/London" });
  assert.equal(a.id, b.id, "same phone must resolve to the same user");
  const found = await getUserByPhone(d, phone);
  assert.equal(found?.timezone, "Africa/Lagos", "existing timezone must not be overwritten");
});

test("saveMessage dedupes on Meta's message id (webhook redelivery)", { skip }, async () => {
  const d = getDb();
  const id = `wamid.test.${randomUUID()}`;
  const first = await saveMessage(d, { id, userId, direction: "inbound", body: "hello" });
  const second = await saveMessage(d, { id, userId, direction: "inbound", body: "hello" });
  assert.equal(first, true, "first delivery inserts");
  assert.equal(second, false, "redelivery is a no-op");
});

test("listHistory returns messages oldest first for prompts", { skip }, async () => {
  const d = getDb();
  const suffix = randomUUID().slice(0, 8);
  await saveMessage(d, { id: `m-${suffix}-1`, userId, direction: "inbound", body: "one" });
  await saveMessage(d, { id: `m-${suffix}-2`, userId, direction: "outbound", body: "two" });
  await saveMessage(d, { id: `m-${suffix}-3`, userId, direction: "inbound", body: "three" });

  const history = (await listHistory(d, userId, 10)).filter((m) =>
    m.id.startsWith(`m-${suffix}-`),
  );
  assert.deepEqual(
    history.map((m) => m.body),
    ["one", "two", "three"],
  );
  assert.deepEqual(
    history.map((m) => m.direction),
    ["inbound", "outbound", "inbound"],
  );
});

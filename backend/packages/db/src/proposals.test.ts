import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb, type Db } from "./client.js";
import { runMigrations } from "./migrations.js";
import { hashPayload } from "./canonical.js";
import {
  claimProposal,
  createProposal,
  ensureUser,
  getProposal,
  listPendingProposals,
  rejectProposal,
  type ProposalPayload,
} from "./repos.js";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set — skipping DB integration test";

let db: Db | null = null;
const userIds: string[] = [];

function getDb(): Db {
  if (!db) throw new Error("database not initialised");
  return db;
}

async function makeUser(): Promise<string> {
  const user = await ensureUser(getDb(), {
    phone: `proposal-${randomUUID().slice(0, 12)}`,
    timezone: "Africa/Lagos",
  });
  userIds.push(user.id);
  return user.id;
}

function payload(overrides: Partial<ProposalPayload> = {}): ProposalPayload {
  const start = new Date(Date.now() + 86_400_000);
  return {
    eventId: `evt-${randomUUID()}`,
    calendarId: "primary",
    title: "Board review",
    before: {
      start: start.toISOString(),
      end: new Date(start.getTime() + 3_600_000).toISOString(),
    },
    after: {
      start: new Date(start.getTime() + 3_600_000).toISOString(),
      end: new Date(start.getTime() + 7_200_000).toISOString(),
    },
    etag: null,
    timezone: "Africa/Lagos",
    attendees: 0,
    sendUpdates: "all",
    ...overrides,
  };
}

function makeProposal(userId: string, p: ProposalPayload, expiresIn = 3_600_000) {
  return createProposal(getDb(), {
    userId,
    kind: p.action === "cancellation" ? "cancellation" : "reschedule",
    payload: p,
    payloadHash: hashPayload(p),
    expiresAt: new Date(Date.now() + expiresIn),
  });
}

before(async () => {
  if (!url) return;
  db = createDb(url, { max: 2 });
  await runMigrations(db);
});

after(async () => {
  if (!db) return;
  for (const id of userIds) await db`delete from users where id = ${id}`;
  await db.end();
});

test(
  "a stored payload comes back as an object and still matches its hash",
  { skip },
  async () => {
    const userId = await makeUser();
    const p = payload();
    const created = await makeProposal(userId, p);
    const reread = (await getProposal(getDb(), created.id))!;
    assert.equal(typeof reread.payload, "object", "jsonb is not double-encoded");
    assert.equal(
      hashPayload(reread.payload),
      reread.payload_hash,
      "the hash verifies after a real round trip",
    );
  },
);

test(
  "a cancellation proposal is accepted and an unknown kind is refused",
  { skip },
  async () => {
    const userId = await makeUser();
    const created = await makeProposal(userId, payload({ action: "cancellation", after: undefined }));
    assert.equal(created.kind, "cancellation");
    await assert.rejects(
      getDb()`insert into proposals (user_id, kind, payload, payload_hash, expires_at)
                values (${userId}, 'injected', '{}'::jsonb, 'x', now() + interval '1 hour')`,
      (err: { code?: string }) => err.code === "23514",
    );
  },
);

test(
  "claim, reject, expiry and ownership are enforced by the statement",
  { skip },
  async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const created = await makeProposal(owner, payload());

    assert.deepEqual(await listPendingProposals(getDb(), stranger), []);
    assert.equal(await claimProposal(getDb(), { id: created.id, userId: stranger }), null);
    assert.equal(await rejectProposal(getDb(), { id: created.id, userId: stranger }), null);

    const claimed = await claimProposal(getDb(), { id: created.id, userId: owner });
    assert.equal(claimed?.status, "executing");
    assert.equal(
      await claimProposal(getDb(), { id: created.id, userId: owner }),
      null,
      "a second tap cannot execute it again",
    );
    assert.equal(await rejectProposal(getDb(), { id: created.id, userId: owner }), null);

    const stale = await makeProposal(owner, payload(), -1_000);
    assert.equal(await claimProposal(getDb(), { id: stale.id, userId: owner }), null);
    assert.deepEqual(await listPendingProposals(getDb(), owner), []);
  },
);

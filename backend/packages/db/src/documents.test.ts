import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb, type Db } from "./client.js";
import { runMigrations } from "./migrations.js";
import {
  claimDocumentJobs,
  cleanupDocumentJobs,
  createDocumentJob,
  ensureUser,
  getDocumentJob,
  markDocumentJobFailed,
  markDocumentJobSent,
  markDocumentJobUploading,
  type User,
} from "./repos.js";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set — skipping DB integration test";

let db: Db | null = null;
const userIds: string[] = [];

function getDb(): Db {
  if (!db) throw new Error("database not initialised");
  return db;
}

async function makeUser(): Promise<User> {
  const user = await ensureUser(getDb(), {
    phone: `doc-${randomUUID().slice(0, 12)}`,
    timezone: "Africa/Lagos",
  });
  userIds.push(user.id);
  return user;
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

const payload = {
  timezone: "Africa/Lagos",
  rangeLabel: "23 Nov – 29 Nov 2026",
  events: [
    {
      title: "Board review",
      start: "2026-11-23T09:00:00Z",
      end: "2026-11-23T10:00:00Z",
    },
  ],
};

test("a replayed webhook request reuses the same job", { skip }, async () => {
  const user = await makeUser();
  const requestMessageId = `wamid.${randomUUID()}`;
  const first = await createDocumentJob(getDb(), {
    userId: user.id,
    requestMessageId,
    kind: "pdf",
    title: "Summary",
    payload,
  });
  const second = await createDocumentJob(getDb(), {
    userId: user.id,
    requestMessageId,
    kind: "pdf",
    title: "Summary",
    payload,
  });
  assert.equal(first.id, second.id);
});

test("claiming is exclusive and joins the recipient", { skip }, async () => {
  const user = await makeUser();
  const job = await createDocumentJob(getDb(), {
    userId: user.id,
    requestMessageId: `wamid.${randomUUID()}`,
    kind: "docx",
    title: "Summary",
    payload,
  });

  const claimed = await claimDocumentJobs(getDb(), 10);
  const mine = claimed.find((row) => row.id === job.id);
  assert.ok(mine, "the queued job is claimed");
  assert.equal(mine.phone, user.phone, "delivery address is joined in");
  assert.equal(mine.user_timezone, "Africa/Lagos");

  const again = await claimDocumentJobs(getDb(), 10);
  assert.equal(
    again.some((row) => row.id === job.id),
    false,
    "a claimed job is not claimable twice",
  );
});

test("two workers cannot claim the same job concurrently", { skip }, async () => {
  const user = await makeUser();
  const job = await createDocumentJob(getDb(), {
    userId: user.id,
    requestMessageId: `wamid.${randomUUID()}`,
    kind: "pdf",
    title: "Concurrent",
    payload,
  });
  const other = createDb(url!, { max: 1 });
  try {
    const [first, second] = await Promise.all([
      claimDocumentJobs(getDb(), 100),
      claimDocumentJobs(other, 100),
    ]);
    const claims = [...first, ...second].filter((row) => row.id === job.id);
    assert.equal(claims.length, 1, "exactly one worker claims the job");
  } finally {
    await other.end();
  }
});

test("jobs are owned by their user and cannot be replayed across users", { skip }, async () => {
  const owner = await makeUser();
  const other = await makeUser();
  const requestMessageId = `wamid.${randomUUID()}`;
  const job = await createDocumentJob(getDb(), {
    userId: owner.id,
    requestMessageId,
    kind: "docx",
    title: "Owner only",
    payload,
  });

  await assert.rejects(
    createDocumentJob(getDb(), {
      userId: other.id,
      requestMessageId,
      kind: "docx",
      title: "Leaked",
      payload,
    }),
    /belongs to another user/,
    "a replay with another user id never returns the owner's job",
  );

  const claims = await claimDocumentJobs(getDb(), 100);
  const claimed = claims.find((row) => row.id === job.id);
  assert.equal(claimed?.user_id, owner.id);
  assert.equal(claimed?.phone, owner.phone, "delivery goes to the owning user's phone");
  assert.notEqual(owner.phone, other.phone);

  await assert.rejects(
    getDb()`update document_jobs set kind = 'xls' where id = ${job.id}`,
    /document_jobs_kind_check/,
    "the format constraint rejects unsupported files",
  );
});

test("a backed-off job is not claimable until its retry time", { skip }, async () => {
  const user = await makeUser();
  const job = await createDocumentJob(getDb(), {
    userId: user.id,
    requestMessageId: `wamid.${randomUUID()}`,
    kind: "pdf",
    title: "Backoff",
    payload,
  });
  await claimDocumentJobs(getDb(), 100);
  const retryAt = new Date(Date.now() + 60_000);
  await markDocumentJobFailed(getDb(), job.id, "temporary", true, retryAt);

  const early = await claimDocumentJobs(getDb(), 100);
  assert.equal(early.some((row) => row.id === job.id), false);

  await getDb()`update document_jobs set next_attempt_at = now() - interval '1 second' where id = ${job.id}`;
  const due = await claimDocumentJobs(getDb(), 100);
  assert.equal(due.some((row) => row.id === job.id), true);
});

test("delivery is recorded only after the provider accepts it", { skip }, async () => {
  const user = await makeUser();
  const job = await createDocumentJob(getDb(), {
    userId: user.id,
    requestMessageId: `wamid.${randomUUID()}`,
    kind: "pptx",
    title: "Summary",
    payload,
  });
  await claimDocumentJobs(getDb(), 50);
  await markDocumentJobUploading(getDb(), job.id);

  const uploading = await getDocumentJob(getDb(), job.id);
  assert.equal(uploading?.status, "uploading");

  await markDocumentJobSent(getDb(), job.id, {
    mediaId: "media-1",
    messageId: "wamid.out.1",
  });
  const sent = await getDocumentJob(getDb(), job.id);
  assert.equal(sent?.status, "sent");
  assert.equal(sent?.wa_media_id, "media-1");
  assert.equal(sent?.wa_message_id, "wamid.out.1");
  assert.ok(sent?.completed_at);
});

test("a transient failure is requeued and an exhausted one is terminal", { skip }, async () => {
  const user = await makeUser();
  const job = await createDocumentJob(getDb(), {
    userId: user.id,
    requestMessageId: `wamid.${randomUUID()}`,
    kind: "pdf",
    title: "Summary",
    payload,
  });
  await claimDocumentJobs(getDb(), 50);

  await markDocumentJobFailed(getDb(), job.id, "upload timed out", true, new Date());
  const retried = await getDocumentJob(getDb(), job.id);
  assert.equal(retried?.status, "queued");
  assert.equal(retried?.error, "upload timed out");

  await claimDocumentJobs(getDb(), 50);
  await markDocumentJobFailed(getDb(), job.id, "permanent", false);
  const failed = await getDocumentJob(getDb(), job.id);
  assert.equal(failed?.status, "failed");
  assert.ok(failed?.completed_at);
});

test("retention cleanup removes only finished, old jobs", { skip }, async () => {
  const user = await makeUser();
  const job = await createDocumentJob(getDb(), {
    userId: user.id,
    requestMessageId: `wamid.${randomUUID()}`,
    kind: "pdf",
    title: "Old",
    payload,
  });
  await claimDocumentJobs(getDb(), 50);
  await markDocumentJobSent(getDb(), job.id, { mediaId: "m", messageId: "w" });
  await getDb()`
    update document_jobs set updated_at = now() - interval '30 days'
    where id = ${job.id}`;

  const fresh = await createDocumentJob(getDb(), {
    userId: user.id,
    requestMessageId: `wamid.${randomUUID()}`,
    kind: "pdf",
    title: "Fresh",
    payload,
  });

  await cleanupDocumentJobs(getDb(), 7);
  assert.equal(await getDocumentJob(getDb(), job.id), null, "old finished job is gone");
  assert.ok(await getDocumentJob(getDb(), fresh.id), "a queued job is never swept");
});

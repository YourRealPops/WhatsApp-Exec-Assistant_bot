import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claimDocumentJobs,
  cleanupDocumentJobs,
  markDocumentJobFailed,
  markDocumentJobSent,
  markDocumentJobUploading,
  requeueStuckDocumentJobs,
  type DocumentJobDetail,
} from "@exec-assistant/db";
import {
  generateDocument,
  validateDocument,
  type DocumentRequest,
} from "@exec-assistant/documents";
import { briefFromPayload, generateAuthoredContent } from "./document-content.js";
import type { WorkerConfig } from "./sync.js";

/** A failure no retry can fix: bad request, bad file, closed messaging window. */
class PermanentDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentDocumentError";
  }
}

function documentDir(cfg: WorkerConfig): string {
  return cfg.document.tmpDir ?? join(tmpdir(), "ecos-documents");
}

/**
 * Files live only for the duration of one attempt; the database is the
 * durable state. Nothing is expected to survive a Render restart.
 */
async function ensureDocumentDir(cfg: WorkerConfig): Promise<string> {
  const dir = documentDir(cfg);
  await mkdir(dir, { recursive: true });
  return dir;
}

function normalizePayload(job: DocumentJobDetail): DocumentJobDetail["payload"] {
  if (typeof job.payload === "string") {
    try {
      return JSON.parse(job.payload) as DocumentJobDetail["payload"];
    } catch {
      return { timezone: job.user_timezone, rangeLabel: "", events: [] };
    }
  }
  return job.payload ?? { timezone: job.user_timezone, rangeLabel: "", events: [] };
}

async function requestForJob(
  cfg: WorkerConfig,
  job: DocumentJobDetail,
): Promise<DocumentRequest> {
  const payload = normalizePayload(job);
  const generatedFor = job.user_name ?? payload.generatedFor ?? null;
  const generatedAt = new Date().toISOString();

  if (payload.source === "general") {
    const authored = await generateAuthoredContent(
      briefFromPayload(payload, {
        kind: job.kind,
        title: job.title,
        userName: job.user_name,
      }),
      cfg.llm ?? null,
    );
    return {
      kind: job.kind,
      source: "general",
      title: authored.title,
      subtitle: authored.subtitle,
      timezone: job.user_timezone || payload.timezone || "UTC",
      sections: authored.sections,
      slideCount: payload.slideCount,
      generatedFor,
      generatedAt,
    };
  }

  return {
    kind: job.kind,
    source: "calendar",
    title: job.title,
    timezone: payload.timezone || job.user_timezone || "UTC",
    rangeLabel: payload.rangeLabel ?? "",
    events: Array.isArray(payload.events) ? payload.events : [],
    generatedFor,
    generatedAt,
  };
}

function captionFor(job: DocumentJobDetail, payload: DocumentJobDetail["payload"]): string {
  if (payload.source === "general") return job.title;
  return payload.rangeLabel ? `${job.title} — ${payload.rangeLabel}` : job.title;
}

/** Retry transient delivery failures with a short backoff, capped at 5 min. */
function retryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(attempts - 1, 0), 5 * 60_000);
}

/**
 * A closed 24h messaging window cannot be fixed by retrying: WhatsApp will
 * reject every free-form send until the user messages us again. The job is
 * recorded as failed with that reason rather than pretending it was sent.
 */
function isWindowRefusal(message: string): boolean {
  return /\b131047\b|re-engagement|24[- ]?hour|outside.*window|131026/i.test(message);
}

async function processJob(
  cfg: WorkerConfig,
  job: DocumentJobDetail,
): Promise<boolean> {
  const path = join(await ensureDocumentDir(cfg), `${job.id}.${job.kind}`);
  const label = job.user_id.slice(0, 8);
  try {
    const payload = normalizePayload(job);
    const request = await requestForJob(cfg, job);
    const file = await generateDocument(request, path, {
      maxBytes: cfg.document.maxBytes,
      maxEvents: cfg.document.maxEvents,
    });

    const validation = await validateDocument(path, job.kind, {
      maxBytes: cfg.document.maxBytes,
      maxEvents: cfg.document.maxEvents,
    });
    if (!validation.valid) {
      throw new PermanentDocumentError(
        `generated ${job.kind.toUpperCase()} failed validation: ${validation.reason}`,
      );
    }

    if (!cfg.sender.uploadMedia || !cfg.sender.sendDocument) {
      throw new PermanentDocumentError(
        "the configured sender does not support document delivery",
      );
    }

    await markDocumentJobUploading(cfg.db, job.id);
    const mediaId = await cfg.sender.uploadMedia({
      data: await readFile(path),
      mimeType: file.mimeType,
      filename: file.filename,
    });
    const caption = captionFor(job, payload);
    const messageId = await cfg.sender.sendDocument(
      job.phone,
      mediaId,
      file.filename,
      caption,
    );

    // Only now is the document delivered: WhatsApp accepted the message.
    await markDocumentJobSent(cfg.db, job.id, { mediaId, messageId });
    console.log(
      `[worker] ${payload.source === "general" ? "general" : "calendar"} ` +
        `${job.kind.toUpperCase()} sent to user ${label} ` +
        `(${file.bytes} bytes, media ${mediaId})`,
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const permanent =
      err instanceof PermanentDocumentError || isWindowRefusal(message);
    const retry = !permanent && job.attempts < job.max_attempts;
    const nextAttemptAt = retry
      ? new Date(Date.now() + retryDelayMs(job.attempts))
      : null;
    await markDocumentJobFailed(cfg.db, job.id, message, retry, nextAttemptAt).catch(
      () => {},
    );
    const suffix = retry
      ? ` — will retry in ${Math.round(retryDelayMs(job.attempts) / 1000)}s`
      : " — giving up";
    console.error(
      `[worker] document ${job.kind.toUpperCase()} for user ${label} failed: ${message}${suffix}`,
    );
    return false;
  } finally {
    await rm(path, { force: true }).catch(() => {});
  }
}

export interface DocumentTickResult {
  claimed: number;
  sent: number;
  failed: number;
}

/**
 * Claim and process a batch of queued document jobs. Jobs for different users
 * run concurrently (bounded by DOCUMENT_CONCURRENCY); the atomic claim means a
 * second worker instance can run the same batch shape without collisions.
 */
export async function processDocumentJobs(
  cfg: WorkerConfig,
): Promise<DocumentTickResult> {
  // Recover jobs a previous process left in-flight (crash/restart) before
  // claiming new work; their attempts count, so a poison job eventually ends.
  const recovered = await requeueStuckDocumentJobs(cfg.db, 30).catch((err) => {
    console.error("[worker] stuck document recovery failed:", err);
    return 0;
  });
  if (recovered > 0) {
    console.warn(`[worker] recovered ${recovered} interrupted document job(s)`);
  }

  const jobs = await claimDocumentJobs(cfg.db, cfg.document.concurrency);
  if (jobs.length === 0) return { claimed: 0, sent: 0, failed: 0 };

  const results = await Promise.allSettled(jobs.map((job) => processJob(cfg, job)));
  let sent = 0;
  let failed = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      if (result.value) sent += 1;
      else failed += 1;
    } else {
      failed += 1;
      console.error("[worker] document job crashed outside its handler:", result.reason);
    }
  }
  return { claimed: jobs.length, sent, failed };
}

/**
 * Retention sweep: finished job rows are deleted after DOCUMENT_RETENTION_DAYS
 * and orphaned temp files after an hour. A crash mid-generation therefore
 * never leaves files behind forever.
 */
export async function cleanupDocumentArtifacts(cfg: WorkerConfig): Promise<number> {
  const rows = await cleanupDocumentJobs(cfg.db, cfg.document.retentionDays).catch(
    (err) => {
      console.error("[worker] document job cleanup failed:", err);
      return 0;
    },
  );

  const dir = documentDir(cfg);
  let files = 0;
  try {
    for (const name of await readdir(dir)) {
      const full = join(dir, name);
      const info = await stat(full).catch(() => null);
      if (info?.isFile() && Date.now() - info.mtimeMs > 3_600_000) {
        await rm(full, { force: true }).catch(() => {});
        files += 1;
      }
    }
  } catch {
    // The directory does not exist until the first job; nothing to clean.
  }
  if (rows > 0 || files > 0) {
    console.log(
      `[worker] document cleanup: ${rows} expired job row(s), ${files} temp file(s)`,
    );
  }
  return rows + files;
}

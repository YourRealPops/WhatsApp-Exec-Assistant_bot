import { Router } from "express";
import {
  getUserByPhone,
  listReminders,
  listUpcomingEvents,
  type Db,
} from "@exec-assistant/db";

/** Read-only inspection routes for development (GET /debug/*). */
export function debugRouter(db: Db, defaultTimezone: string): Router {
  const router = Router();

  router.get("/debug/reminders", async (req, res) => {
    const phone = String(req.query.phone ?? "");
    const user = phone ? await getUserByPhone(db, phone) : null;
    if (phone && !user) return res.status(404).json({ error: "unknown phone" });
    const rows = user
      ? await listReminders(db, user.id, {
          limit: Number(req.query.limit ?? 50),
          status: req.query.status ? String(req.query.status) : undefined,
        })
      : [];
    res.json({ user: user ?? null, reminders: rows });
  });

  router.get("/debug/user/:phone", async (req, res) => {
    const user = await getUserByPhone(db, req.params.phone);
    if (!user) return res.status(404).json({ error: "unknown phone" });
    const tz = user.timezone || defaultTimezone;
    const from = new Date();
    const to = new Date(Date.now() + 14 * 86_400_000);
    const [events, reminders] = await Promise.all([
      listUpcomingEvents(db, user.id, from, to),
      listReminders(db, user.id, { limit: 50 }),
    ]);
    res.json({ user, timezone: tz, events, reminders });
  });

  return router;
}

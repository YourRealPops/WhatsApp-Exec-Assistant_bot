# WhatsApp message templates — proactive reminder copy

Proactive messages (anything sent outside the 24-hour window after the user's
last message) **must use a pre-approved template**. Free-form text only works
inside that window. Submit these as **Utility** templates in your Meta app
dashboard → WhatsApp → Message templates → Create.

Review typically takes minutes to a couple of days — submit early.

## Template 1: `event_reminder` (the whole T-15/T-10/T-5/T-0 ladder)

Category: **Utility** · Language: **en** · Type: **Body**

```text
Hi! {{1}} starts at {{2}}.
Reply to this chat to reschedule, ask for details, or plan the rest of your day.
```

Parameters (matches what the worker sends):

1. `{{1}}` — event title (e.g. "Investor call")
2. `{{2}}` — start time with timezone (e.g. "15:00 GMT+1")

> Note: the template body is fixed, so the exact offset ("in 15 minutes") is
> not in it. Inside the 24-hour window the worker sends richer free-form text
> instead — see below. If you want the offset in the template too, add a third
> parameter and extend `templateParams()` in `apps/worker/src/dispatch.ts`.

## Template 2: `event_starting_now` (T-0)

Category: **Utility** · Language: **en** · Type: **Body**

```text
It's time — {{1}} starts at {{2}}. Reply here if you need anything before it kicks off.
```

## Free-form copy (used inside the 24h session window)

These are the exact strings `buildReminderText()` produces when no template
name is configured:

```text
⏰ Investor call starts in 15 minutes (15:00 GMT+1).
⏰ Investor call starts in 10 minutes (15:00 GMT+1).
⏰ Investor call starts in 5 minutes (15:00 GMT+1).
🔔 It's time — Investor call starts now (15:00 GMT+1).
⏰ Reminder: Call the dentist (09:30 GMT+1).
```

## Wiring it up

1. Create + get the templates approved (above).
2. Set in `.env`:
   ```bash
   REMINDER_TEMPLATE_NAME=event_reminder
   REMINDER_TEMPLATE_LANGUAGE=en
   SENDER=whatsapp
   ```
3. The worker then sends `sendTemplate(title, time)` for every ladder step.

Until the templates are approved, keep `REMINDER_TEMPLATE_NAME` empty — the
worker sends free-form text, which works whenever the user messaged you within
the last 24 hours (fine during development, since every inbound message
restarts that window).

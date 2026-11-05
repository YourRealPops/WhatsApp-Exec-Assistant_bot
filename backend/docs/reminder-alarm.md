# Reminder alarms — ringing the user's phone

Every reminder is delivered as a WhatsApp message (see
[whatsapp-templates.md](./whatsapp-templates.md)). A reminder can **also** be
delivered as a phone call that rings and reads the reminder out loud — the
"alarm" — so it still catches the user when the chat notification is missed.

A WhatsApp message cannot ring like a phone alarm, so the alarm is a real
outbound voice call placed through [Twilio Voice](https://www.twilio.com/docs/voice).

## Which reminders ring

`reminders.alarm` (boolean, default false) decides.

| Reminder | Rings? |
| --- | --- |
| Ad-hoc reminder from `set_reminder` (no calendar event) | Yes, unless the user asked for a message only |
| Calendar ladder (T-15 / T-10 / T-5 / T-0) | No — four calls before one meeting would be hostile |

The assistant can opt a single reminder out by passing `alarm: false` to
`set_reminder` ("just text me about this one").

## What the call says

The alarm speaks a spoken-word variant of the reminder, not the WhatsApp copy —
emoji and 24-hour clocks read badly aloud. From `buildAlarmText()` in
`apps/worker/src/dispatch.ts`:

```text
Reminder. Call the dentist. Due at 9:30 AM GMT+1.
Reminder. Investor call starts in 15 minutes, at 3:00 PM GMT+1.
Reminder. Investor call starts now, at 3:00 PM GMT+1.
```

The line is spoken twice per call, and the call gives up after
`ALARM_RING_SECONDS` of ringing.

## Wiring it up

1. Create a Twilio account and buy a voice-capable number (the caller ID the
   user sees).
2. Set in `.env`:

   ```bash
   ALARM_MODE=twilio
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...          # or TWILIO_API_KEY + TWILIO_API_SECRET
   TWILIO_FROM_NUMBER=+15551234567
   ```

3. Restart the worker. Boot logs the active channel:

   ```text
   [worker]   alarms:    twilio (reminders flagged as alarms will ring)
   ```

If `ALARM_MODE` is unset, alarms switch to `twilio` as soon as the three
credentials above are present, and fall back to `console` otherwise —
`console` only prints the call to the terminal, so the whole pipeline stays
observable without telephony (the same trade-off as `DEV_CALENDAR`).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALARM_MODE` | `twilio` when credentials exist, else `console` | `off`, `console` or `twilio` |
| `TWILIO_ACCOUNT_SID` | — | Required for `twilio` mode |
| `TWILIO_AUTH_TOKEN` | — | Required for `twilio` mode (unless using an API key pair) |
| `TWILIO_API_KEY` / `TWILIO_API_SECRET` | — | Preferred over the auth token |
| `TWILIO_FROM_NUMBER` | — | Provisioned caller ID in E.164 |
| `ALARM_VOICE` | `Polly.Joanna` | Twilio `<Say>` voice |
| `ALARM_LANGUAGE` | `en-US` | Twilio `<Say>` language |
| `ALARM_RING_SECONDS` | `30` | Ring timeout before Twilio hangs up |

## Failure behaviour

The alarm is **best-effort and never retried**. The call is placed only after
the WhatsApp message has been sent successfully, so a retried reminder can never
ring twice. If the call itself fails (unverified destination number on a trial
account, no credit, carrier rejection) the reminder is still marked `sent`, the
error is stored in `reminders.call_error`, and the worker logs:

```text
[worker] alarm call failed for reminder <id>: Twilio call failed (400): ...
```

`reminders.called_at` and `reminders.call_sid` record successful calls.

> Twilio trial accounts can only call **verified** numbers. Verify your own
> number in the Twilio console before testing end-to-end.

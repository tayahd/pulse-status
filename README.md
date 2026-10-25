# Pulse Status

Uptime monitor and status dashboard for Pulse, kept separate from the app itself.

- **Checker:** `monitor.mjs` runs every 5 minutes via GitHub Actions (`.github/workflows/monitor.yml`).
- **Services checked:** Website (Vercel), Sign-in (Supabase Auth), Database (Supabase REST), Bank sync (Supabase Edge Functions).
- **Data:** written to `status.json` on the `data` branch (one commit, force-pushed each run).
- **Dashboard:** `index.html`, served by GitHub Pages: https://tayahd.github.io/pulse-status/
- **Push alerts:** sent through [ntfy](https://ntfy.sh). A failure is retried after 15s before it counts as down. You get an urgent push when a service goes down and a normal one when it recovers.

## Phone setup
1. Install **ntfy** ([iOS](https://apps.apple.com/app/ntfy/id1625396347) / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)).
2. Tap **+**, then subscribe to the topic stored in the `NTFY_TOPIC` repo secret (server: ntfy.sh).
3. Actions → Monitor → *Run workflow* → tick "Send a test push notification".

Keep the topic name private. Anyone who knows it can read or send to it.

## Secrets
| Name | Purpose |
|---|---|
| `NTFY_TOPIC` | ntfy topic that alerts are pushed to |
| `SUPABASE_ANON_KEY` | public anon key used for the Auth and Database checks |

## Local run
```
SUPABASE_ANON_KEY=... node monitor.mjs        # writes ./status.json, prints results
NTFY_TOPIC=... node monitor.mjs --test-notify
python3 -m http.server                          # dashboard reads ./status.json locally
```

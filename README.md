# Entscheidungen — group decisions for TREK

A `trip-page` plugin for [TREK](https://github.com/liketrek/TREK) that covers the part of a group trip
that happens *before* anything is booked: which apartment, which flight, which rental car.

![Entscheidungen in the trip planner](./docs/screenshot.png)

## What it does

The plugin adds a **Decisions** tab right after *Plan* in every trip planner. A decision is an open
question ("Stay in Seville", "Outbound flight") with a category, an optional deadline and any number
of options. Everyone on the trip can add options with a link, a total price and category-specific
details (check-in/out for stays, airports and times for flights, pick-up and return for rental cars),
collect pros and cons, upvote as many options as they like and put a veto on the ones that do not
work for them. Options are ranked by upvotes, cheaper first on a tie, vetoed ones last; who voted for
what is visible to the whole group. A comparison table lines the options up side by side, and the
price per person is computed from the trip's member count (the divisor can be changed).

When the group has made up its mind, one click on **Decide** turns the winning option into TREK data:
a booking of the matching type (a stay becomes a hotel booking with an accommodation block on the
trip days and a place on the map; flights get their from/to airports), a cost linked to that booking,
the other options archived and the group notified. Every write runs with the permissions of the person
who clicked, so a missing right or a disabled Costs addon is reported instead of failing the decision.
A passed deadline only marks the vote as ended and highlights the top option — nothing is ever booked
automatically. A decision can be reopened; the plugin then asks whether the created booking should be
deleted too. All open sessions update live. The UI follows the TREK theme (light/dark), works on phone
and desktop and is available in German and English.

The cost is split equally between the trip members (the decide dialog lets you pick who shares it).
Prices in a foreign currency are converted into the trip currency with TREK's exchange rates and shown
next to the original. Beyond its own tab the plugin shows up natively in TREK: the options of open
decisions appear as markers on the trip map (handy for comparing where the apartments are), the planner
shows a banner when a decision closes within three days, and dashboard trip cards carry an
"open decisions" badge. If the Collab addon is enabled, a decision can be posted as a Collab poll and
the poll's votes imported back; the plugin's own votes stay authoritative.

If TREK has an AI model set up (the **AI Parsing** addon), the option form offers to read a pasted
listing, offer or confirmation email and pre-fill the fields; the result is checked like any input and
nothing is saved until you press save. No pages are fetched or scraped. An assistant connected to TREK's
MCP server can list the decisions of a trip, create a decision and add options (tools
`plugin_entscheidungen_list_decisions`, `…_create_decision`, `…_add_option`); TREK does not tell the
plugin which user runs a tool, so such rows are shown as created by the assistant. When a TREK account
is deleted, the plugin removes that person's votes and pros/cons and unlinks their name from shared
decisions and options; an admin data export includes what the plugin stores about a person.

## Screenshots

The decision view with option cards, votes, pros and cons is shown above. The store image lives at
`docs/screenshot.png`; more previews (light/dark, phone, comparison table, dialogs) can be generated
with `node scripts/preview-shots.mjs` against a running dev server.

## Permissions

| Permission | Why |
|---|---|
| `db:own` | Stores decisions, options, pros/cons, votes and a per-trip divisor in the plugin's own SQLite database. |
| `db:read:trips` | Checks trip membership before every request (the own database is not membership-checked), reads the trip's currency, days (to place a stay on trip days) and member list. |
| `db:read:users` | Resolves the trip owner's display name, who is not part of the member list. |
| `ws:broadcast:trip` | Pings the trip's open sessions after a change so every member's view refreshes live. |
| `db:write:reservations` | Creates the booking for the chosen option (and deletes it on request when a decision is reopened). |
| `db:write:places` | Creates a place from the address/coordinates of a chosen stay so the accommodation shows on the map. |
| `db:write:costs` | Adds the chosen option's price as a cost linked to the booking (needs the Costs addon). |
| `notify:send` | Notifies the trip members that a decision has been made. |
| `db:read:collab` | Detects whether the Collab addon is available and reads the votes of a poll the plugin posted. |
| `db:write:collab` | Posts a decision's options as a Collab poll (only on request). |
| `rates:read` | Converts prices in a foreign currency into the trip currency. |
| `hook:map-marker-provider` | Shows the options of open decisions that have coordinates as markers on the trip map. |
| `hook:trip-warning-provider` | Shows a planner banner when an open decision closes within three days or its vote has ended. |
| `hook:trip-card-provider` | Adds an "open decisions" badge to the dashboard trip cards. |
| `ai:invoke` | Reads a pasted listing/offer with the AI model configured in TREK to pre-fill the option form (output is only a draft). |
| `mcp:tools` | Publishes three tools (list decisions, create decision, add option) for assistants connected to TREK's MCP server. |
| `hook:user-data` | Deletes and exports a person's votes, pros/cons and authorship when TREK handles an account deletion or data request. |

## Setup

Upload `plugin.zip` under **Admin → Plugins** (sideload), activate it and approve the permissions. No
settings are needed. Requires TREK 4.3 or newer. For bookings and costs, the clicking user needs the
usual TREK rights on the trip (`reservation_edit`, `place_edit`, `budget_edit`). Optional extras use
TREK's own features: the Collab addon for polls, the Costs addon for costs, and the AI Parsing addon
with a configured model (Admin → Addons, or per user under Settings → Integrations) for the AI import.

Development: `npm install`, then `npm run dev` (serves http://localhost:4317/preview), `npm run seed`
for example data from `dev-fixtures.json`, and `npm test` for the unit tests. The bundled airport table
(`server/data/airports.json`) is built from OurAirports (public domain) by `npm run build:airports`.

## License

MIT

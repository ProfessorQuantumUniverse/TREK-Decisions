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

## Setup

Upload `plugin.zip` under **Admin → Plugins** (sideload), activate it and approve the permissions. No
settings are needed. Requires TREK 4.3 or newer. For bookings and costs, the clicking user needs the
usual TREK rights on the trip (`reservation_edit`, `place_edit`, `budget_edit`).

Development: `npm install`, then `npm run dev` (serves http://localhost:4317/preview), `npm run seed`
for example data from `dev-fixtures.json`, and `npm test` for the unit tests. The bundled airport table
(`server/data/airports.json`) is built from OurAirports (public domain) by `npm run build:airports`.

## License

MIT

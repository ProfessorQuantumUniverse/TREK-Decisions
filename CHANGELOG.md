# Changelog

## 0.4.1
Hardening release after a security and robustness review. No new features, no schema change.
- Votes count only while the voter is on the trip: someone who left or was removed no longer
  sways the ranking, the leader or the map markers (their rows are kept and count again on rejoin).
- *Decide* and *Reopen* run one at a time per decision, so a double click or two members deciding
  at once can no longer create the booking and the cost twice; the group is notified only once.
- The category of a decision is locked on the server once it has options (the form already did
  this), so option details and the booking type cannot drift apart.
- Limits per trip: 200 decisions, 50 options per decision, 100 pros/cons per option (409 `limit_reached`).
- Option links with embedded credentials (`https://booking.com@evil.example/`) are refused; bidi
  override characters are stripped from all text.
- Deadlines accept ISO 8601 only; a date-time without an offset is read as UTC instead of in the
  server's time zone.
- `npm run version:set` also updates `package-lock.json`.

## 0.4.0
- Tidier option cards: four key facts with "more details", source link chip, votes and *Decide* in one row.
- Link autofill: stay dates, Booking.com hotel name and map coordinates are read from a pasted link (no page is fetched).
- Overview shows the leading option's price and votes.
- Repository: English setup guide, `npm run build`, CI and release GitHub Actions.

## 0.3.0
- AI import of a pasted listing/offer (uses TREK's AI Parsing model), MCP tools, GDPR erasure/export.

## 0.2.0
- Cost split between members, Collab poll (post + import votes), map markers, planner banner,
  dashboard badge, currency conversion.

## 0.1.0
- Decisions, options, pros/cons, upvotes/vetoes with ranking, live sync, comparison table,
  decide → booking (stay with accommodation block, flights with airports) + cost + notification.

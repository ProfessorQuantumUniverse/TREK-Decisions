// Server-side strings: what the plugin writes into TREK (booking notes, the group
// notification). They are written in the language of the user who clicked.

const STRINGS = {
  de: {
    'notes.price': 'Preis',
    'notes.beds': 'Schlafplätze',
    'notes.cancellation': 'Stornierung',
    'notes.stops': 'Umstiege',
    'notes.baggage': 'Gepäck',
    'notes.changes': 'Umstiege',
    'notes.return': 'Rückgabe',
    'notes.carClass': 'Fahrzeugklasse',
    'notes.footer': 'Übernommen aus „Entscheidungen“.',
    'notify.title': 'Entschieden: {decision}',
    'notify.body': '{option}{price} — entschieden von {user}.',
    'warning.deadline': 'Entscheidung „{decision}“ endet {when} — noch offen.',
    'warning.ended': 'Abstimmung „{decision}“ ist beendet — jemand muss noch entscheiden.',
    'when.today': 'heute',
    'when.tomorrow': 'morgen',
    'when.days': 'in {n} Tagen',
    'card.open': 'Offene Entscheidungen',
    'card.open.one': 'Offene Entscheidung',
    'marker.votes': '{n} Stimmen',
    'marker.vote': '1 Stimme',
    'marker.veto': 'Veto',
    'someone': 'jemandem',
  },
  en: {
    'notes.price': 'Price',
    'notes.beds': 'Beds',
    'notes.cancellation': 'Cancellation',
    'notes.stops': 'Stops',
    'notes.baggage': 'Baggage',
    'notes.changes': 'Changes',
    'notes.return': 'Return',
    'notes.carClass': 'Car class',
    'notes.footer': 'Taken over from "Decisions".',
    'notify.title': 'Decided: {decision}',
    'notify.body': '{option}{price} — decided by {user}.',
    'warning.deadline': 'Decision "{decision}" closes {when} — still open.',
    'warning.ended': 'Voting on "{decision}" has ended — someone still has to decide.',
    'when.today': 'today',
    'when.tomorrow': 'tomorrow',
    'when.days': 'in {n} days',
    'card.open': 'Open decisions',
    'card.open.one': 'Open decision',
    'marker.votes': '{n} votes',
    'marker.vote': '1 vote',
    'marker.veto': 'veto',
    'someone': 'someone',
  },
}

function lang(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('de') ? 'de' : 'en'
}

function text(locale, key, vars = {}) {
  const s = STRINGS[lang(locale)][key] ?? STRINGS.en[key] ?? key
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? '' : String(vars[k])))
}

module.exports = { text, lang }

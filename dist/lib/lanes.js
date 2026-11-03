'use strict'
// Lanes (design "Lanes"): Unread, Alerts (only with alert senders), Read. Inside a lane: triage
// priority, then the newest message. Unread is Gmail's own UNREAD label, which the plugin changes
// only on Mark read / Mark unread or an open with markReadOnOpen (0.3.0); it keeps no seen state of its own.

const LANES = [
  { id: 'unread', title: 'Unread' },
  { id: 'alerts', title: 'Alerts' },
  { id: 'read', title: 'Read' },
]
const LANE_IDS = LANES.map((l) => l.id)

const RANK = { urgent: 0, action: 1, fyi: 2, noise: 3 }

/**
 * Rows of one lane in the panel's order. `verdict` is the triage verdict or null: without one (no
 * triage, an error) a row sorts after the judged ones, by its time.
 * @param {{ id: string, at: number, verdict?: { priority: string } | null }[]} rows
 */
function sortRows(rows) {
  const rank = (r) => (r.verdict && r.verdict.priority in RANK ? RANK[r.verdict.priority] : 4)
  return [...rows].sort((a, b) => rank(a) - rank(b) || (b.at || 0) - (a.at || 0) || (a.id < b.id ? -1 : 1))
}

module.exports = { LANES, LANE_IDS, RANK, sortRows }

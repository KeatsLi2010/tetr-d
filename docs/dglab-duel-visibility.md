# DG-LAB duel visibility and feedback rules

During a duel, each side has a compact `DG-LAB / LIVE INTENSITY` panel with
two channel bars. The local and opponent bars use lime, orange, and red
thresholds relative to each channel's device-reported limit.

The duel transport sends only an ephemeral, throttled feedback state (at most
10 updates per second): connected/armed flags and current A/B strength/limit.
Device IDs, waveforms, event weights, queue contents, and local configuration
never leave the browser. Feedback is not included in snapshots, deltas, or
replay files. It is cleared on disarm, disconnect, leave, and match end.

Penalty output is additive. Each accepted event contributes points to the
active output; the target strength is recalculated from the sum and capped by
the local safety limit. `attackCancelled` removes points from the newest
contributions first.

Every contribution has its own expiry. Expiration recalculates the target
strength, producing natural decay instead of resetting the device on every
event. A zero target sends the normal clear/zero-strength command.

# The Session Host owns the Steering Queue

Messages sent while a turn is in flight are held by the Session Host and released on turn end,
rather than being handed to the backend to queue. The two SDKs disagree here: pi models a queue
explicitly and exposes it, and the Claude Agent SDK has no queue concept at all. Holding the queue
one level up gives both identical semantics for roughly ten lines of code, and makes reported queue
depth true for every backend. The consequence to respect is that the pi adapter must always send
with `steer` and never use pi's native `followUp` — two queues would make the reported depth a lie.

A send acknowledges acceptance, not turn completion. The host validates the request and records the
human message (or Steering Queue entry) before returning; it does not await an SDK prompt promise
that may last for the whole turn. Progress and failures are reported through the Presentation
Transcript and its event stream. An initiating prompt rejection without a terminal backend event
closes the visible turn and releases the Steering Queue. Rejecting a steering request does not end
the original turn, and accepting one does not hide a later failure of the original prompt. A late
rejection from an ended turn or replaced Backend Session must not interrupt newer work. Clients never automatically replay a send after a
proxy timeout: the host may already have accepted it.

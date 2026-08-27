# The Session Host owns the Steering Queue

Messages sent while a turn is in flight are held by the Session Host and released on turn end,
rather than being handed to the backend to queue. The two SDKs disagree here: pi models a queue
explicitly and exposes it, and the Claude Agent SDK has no queue concept at all. Holding the queue
one level up gives both identical semantics for roughly ten lines of code, and makes reported queue
depth true for every backend. The consequence to respect is that the pi adapter must always send
with `steer` and never use pi's native `followUp` — two queues would make the reported depth a lie.

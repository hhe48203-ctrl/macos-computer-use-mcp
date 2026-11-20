--------------------------- MODULE Lifecycle ---------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Remote, MaxEvals, MaxCalls, MaxSessions, MaxResets, LeaseTicks

Evals == 1..MaxEvals
Calls == 1..MaxCalls
Sessions == 1..MaxSessions
Stopping == {"term", "kill", "exited", "crashed"}

VARIABLES generation, evals, calls, helper, conn, ref, audit
vars == <<generation, evals, calls, helper, conn, ref, audit>>

\* Id 0 means absent. The host and client hold separate views of the socket.
\* Helper epochs identify processes, while bridge generations fence queued work.
Init ==
    /\ generation = 0
    /\ evals = [e \in Evals |-> [state |-> "unused", gen |-> 0]]
    /\ calls = [c \in Calls |-> [owner |-> 0, phase |-> "unused", op |-> "observe",
         bridge |-> 0, session |-> 0, epoch |-> 0, ax |-> 0, applied |-> FALSE,
         reply |-> "none", outcome |-> "none", dispatches |-> 0, settlements |-> 0]]
    /\ helper = [phase |-> "down", epoch |-> 0, observed |-> 0, gen |-> 0, slot |-> 0, replWait |-> 0]
    /\ conn = [host |-> 0, client |-> 0, last |-> 0, link |-> "down", age |-> 0,
         retirement |-> [s \in Sessions |-> "none"], waitFor |-> [s \in Sessions |-> 0]]
    /\ ref = 0
    /\ audit = [dispatch |-> TRUE, delivery |-> TRUE]

Active == {e \in Evals : evals[e].state = "active"}
Live(e) == e \in Active /\ evals[e].gen = generation
NoEarlierEval(e) == \A p \in 1..(e-1) : evals[p].state \notin {"unused", "queued", "active"}
Open(c) == calls[c].phase # "unused" /\ calls[c].outcome = "none"
Waiting == {s \in Sessions : conn.retirement[s] = "waiting"}

Fail(c) == [calls[c] EXCEPT !.outcome = "failed", !.settlements = @ + 1]
FailWhere(cs) == [c \in Calls |-> IF c \in cs /\ Open(c) THEN Fail(c) ELSE calls[c]]
StopHelper == IF helper.phase = "running" THEN [helper EXCEPT !.phase = "term", !.gen = @ + 1]
              ELSE helper

Submit(e) ==
    /\ evals[e].state = "unused"
    /\ \A p \in 1..(e-1) : evals[p].state # "unused"
    /\ evals' = [evals EXCEPT ![e] = [state |-> "queued", gen |-> generation]]
    /\ UNCHANGED <<generation, calls, helper, conn, ref, audit>>

Start(e) ==
    /\ evals[e].state = "queued" /\ evals[e].gen = generation /\ NoEarlierEval(e)
    /\ IF Remote THEN Waiting = {} ELSE helper.observed >= helper.replWait
    /\ evals' = [evals EXCEPT ![e].state = "active"]
    /\ UNCHANGED <<generation, calls, helper, conn, ref, audit>>

Finish(e) ==
    /\ Live(e) /\ \A c \in Calls : calls[c].owner # e \/ ~Open(c)
    /\ evals' = [evals EXCEPT ![e].state = "done"]
    /\ UNCHANGED <<generation, calls, helper, conn, ref, audit>>

CloseClient(status) ==
    IF conn.client = 0 THEN conn
    ELSE [conn EXCEPT !.client = 0, !.retirement[conn.client] = status,
           !.link = IF conn.host # conn.client THEN @
                    ELSE IF @ = "up" THEN "fin" ELSE @]

\* Cancellation and the REPL deadline have the same invalidation as reset.
Invalidate ==
    /\ generation < MaxResets
    /\ Active # {} \/ \E e \in Evals : evals[e].state = "queued"
       \/ helper.phase = "running" \/ conn.client # 0
    /\ generation' = generation + 1
    /\ evals' = [e \in Evals |-> IF evals[e].state \in {"queued", "active"}
                  THEN [evals[e] EXCEPT !.state = "rejected"] ELSE evals[e]]
    /\ calls' = FailWhere(Calls)
    /\ helper' = IF Remote THEN helper ELSE [StopHelper EXCEPT !.replWait = helper.epoch]
    /\ conn' = IF Remote THEN CloseClient("waiting") ELSE conn
    /\ ref' = 0
    /\ UNCHANGED audit

Queue(c, e, op) ==
    /\ Live(e) /\ calls[c].phase = "unused"
    /\ \A p \in 1..(c-1) : calls[p].phase # "unused"
    /\ calls' = [calls EXCEPT ![c].phase = "queued", ![c].owner = e, ![c].op = op,
         ![c].bridge = helper.gen, ![c].ax = IF op = "mutate" THEN ref ELSE 0]
    /\ UNCHANGED <<generation, evals, helper, conn, ref, audit>>

Connect ==
    /\ Remote /\ conn.last < MaxSessions /\ conn.host = 0 /\ conn.client = 0 /\ Waiting = {}
    /\ \E c \in Calls : Open(c) /\ calls[c].phase = "queued"
    /\ conn' = [conn EXCEPT !.host = conn.last + 1, !.client = conn.last + 1,
         !.last = @ + 1, !.age = 0, !.link = "up"]
    /\ UNCHANGED <<generation, evals, calls, helper, ref, audit>>

Send(c) ==
    /\ Remote /\ conn.client # 0 /\ Open(c) /\ calls[c].phase = "queued"
    /\ Live(calls[c].owner) /\ \A p \in 1..(c-1) : ~Open(p)
    /\ calls' = [calls EXCEPT ![c].phase = "wire", ![c].session = conn.client]
    /\ UNCHANGED <<generation, evals, helper, conn, ref, audit>>

Accept(c) ==
    /\ Remote /\ calls[c].phase = "wire" /\ calls[c].session = conn.host
    /\ conn.link \in {"up", "fin"}
    /\ ~\E p \in Calls : calls[p].session = conn.host /\ calls[p].phase \in {"accepted", "native"}
    /\ calls' = [calls EXCEPT ![c].phase = "accepted", ![c].bridge = helper.gen]
    /\ conn' = [conn EXCEPT !.age = 0]
    /\ UNCHANGED <<generation, evals, helper, ref, audit>>

StartHelper ==
    /\ helper.phase = "down" /\ helper.epoch < MaxCalls
    /\ \E c \in Calls : calls[c].bridge = helper.gen /\
          IF Remote THEN calls[c].phase = "accepted" /\ calls[c].session = conn.host
          ELSE Open(c) /\ calls[c].phase = "queued" /\ Live(calls[c].owner)
    /\ helper' = [helper EXCEPT !.phase = "running", !.epoch = @ + 1]
    /\ UNCHANGED <<generation, evals, calls, conn, ref, audit>>

Dispatch(c) ==
    /\ helper.phase = "running" /\ helper.slot = 0 /\ calls[c].bridge = helper.gen
    /\ IF Remote THEN calls[c].phase = "accepted" /\ calls[c].session = conn.host
       ELSE Open(c) /\ calls[c].phase = "queued" /\ Live(calls[c].owner)
            /\ \A p \in 1..(c-1) : ~Open(p)
    /\ helper' = [helper EXCEPT !.slot = c]
    /\ calls' = [calls EXCEPT ![c].phase = "native", ![c].epoch = helper.epoch, ![c].dispatches = @ + 1]
    /\ audit' = [audit EXCEPT !.dispatch = @ /\ helper.observed = helper.epoch - 1
         /\ calls[c].bridge = helper.gen
         /\ (IF Remote THEN conn.host # 0 /\ calls[c].session = conn.host
              ELSE evals[calls[c].owner].gen = generation)]
    /\ UNCHANGED <<generation, evals, conn, ref>>

\* A dispatched action can take effect before its reply, including during shutdown.
Apply(c) ==
    /\ helper.slot = c /\ helper.phase \in {"running", "term"}
    /\ calls[c].op = "mutate" /\ ~calls[c].applied
    /\ calls[c].ax \in {0, helper.epoch}
    /\ calls' = [calls EXCEPT ![c].applied = TRUE]
    /\ UNCHANGED <<generation, evals, helper, conn, ref, audit>>

Reply(c) ==
    /\ helper.slot = c /\ helper.phase = "running"
    /\ calls[c].op = "observe" \/ calls[c].applied \/ calls[c].ax \notin {0, helper.epoch}
    /\ helper' = [helper EXCEPT !.slot = 0]
    /\ calls' = [calls EXCEPT ![c].phase = "replied",
         ![c].reply = IF calls[c].ax \in {0, helper.epoch} THEN "ok" ELSE "staleAX"]
    /\ UNCHANGED <<generation, evals, conn, ref, audit>>

\* A buffered reply can arrive after invalidation. Match the client connection
\* and execution at delivery, rather than consulting the broker's private state.
Deliver(c) ==
    /\ calls[c].phase = "replied" /\ calls[c].reply # "none"
    /\ LET eligible == Open(c) /\ Live(calls[c].owner)
                       /\ (IF Remote THEN calls[c].session = conn.client ELSE calls[c].bridge = helper.gen)
       IN /\ calls' = IF eligible THEN [calls EXCEPT ![c].outcome = calls[c].reply,
                             ![c].settlements = @ + 1, ![c].reply = "none"]
                      ELSE [calls EXCEPT ![c].reply = "none"]
          /\ ref' = IF eligible /\ calls[c].op = "observe" THEN calls[c].epoch ELSE ref
          /\ audit' = [audit EXCEPT !.delivery = @ /\ (eligible =>
                evals[calls[c].owner].state = "active" /\ evals[calls[c].owner].gen = generation)]
    /\ UNCHANGED <<generation, evals, helper, conn>>

\* Current client deadlines settle immediately. The host can still own an old
\* request until it observes release, disconnect or lease expiry.
ClientDeadline(c) ==
    /\ Remote /\ Open(c) /\ calls[c].session = conn.client /\ conn.client # 0
    /\ conn' = CloseClient("waiting")
    /\ calls' = FailWhere(Calls)
    /\ UNCHANGED <<generation, evals, helper, ref, audit>>

RevokeHost == [conn EXCEPT !.waitFor[conn.host] = helper.epoch, !.host = 0,
                          !.link = "down", !.age = 0]

HostRevocation ==
    /\ Remote /\ conn.host # 0
    /\ conn' = RevokeHost
    /\ helper' = StopHelper
    /\ UNCHANGED <<generation, evals, calls, ref, audit>>

HostDisconnect == HostRevocation /\ conn.link \in {"fin", "lost"}
LeaseExpiry == HostRevocation /\ conn.age = LeaseTicks

NativeDeadline(c) ==
    /\ helper.slot = c /\ helper.phase = "running"
    /\ IF Remote THEN HostRevocation /\ conn.host = calls[c].session
       ELSE /\ calls' = FailWhere({p \in Calls : calls[p].bridge = helper.gen})
            /\ helper' = StopHelper
            /\ UNCHANGED <<generation, evals, conn, ref, audit>>

LinkChange(link) ==
    /\ Remote /\ conn.host # 0 /\ conn.link = "up"
    /\ conn' = [conn EXCEPT !.link = link]
    /\ UNCHANGED <<generation, evals, calls, helper, ref, audit>>

Tick ==
    /\ Remote /\ conn.host # 0 /\ conn.age < LeaseTicks
    /\ conn' = [conn EXCEPT !.age = @ + 1]
    /\ UNCHANGED <<generation, evals, calls, helper, ref, audit>>

Heartbeat ==
    /\ Remote /\ conn.host # 0 /\ conn.link = "up" /\ conn.host = conn.client /\ conn.age > 0
    /\ conn' = [conn EXCEPT !.age = 0]
    /\ UNCHANGED <<generation, evals, calls, helper, ref, audit>>

ClientNotice ==
    /\ Remote /\ conn.client # 0
    /\ conn.host # conn.client \/ conn.link = "lost"
    /\ conn' = CloseClient("unconfirmed")
    /\ calls' = FailWhere(Calls)
    /\ UNCHANGED <<generation, evals, helper, ref, audit>>

Confirm(s) ==
    /\ s \in Waiting /\ s # conn.host /\ helper.observed >= conn.waitFor[s]
    /\ conn' = [conn EXCEPT !.retirement[s] = "confirmed"]
    /\ UNCHANGED <<generation, evals, calls, helper, ref, audit>>

SocketDeadline(s) ==
    /\ s \in Waiting
    /\ conn' = [conn EXCEPT !.retirement[s] = "unconfirmed"]
    /\ UNCHANGED <<generation, evals, calls, helper, ref, audit>>

ForceKill ==
    /\ helper.phase = "term"
    /\ helper' = [helper EXCEPT !.phase = "kill"]
    /\ UNCHANGED <<generation, evals, calls, conn, ref, audit>>

ProcessExit ==
    /\ helper.phase \in {"term", "kill"}
    /\ helper' = [helper EXCEPT !.phase = "exited"]
    /\ UNCHANGED <<generation, evals, calls, conn, ref, audit>>

Crash ==
    /\ helper.phase = "running"
    /\ helper' = [helper EXCEPT !.phase = "crashed"]
    /\ UNCHANGED <<generation, evals, calls, conn, ref, audit>>

ObserveExit ==
    /\ helper.phase \in {"crashed", "exited"}
    /\ helper' = [helper EXCEPT !.phase = "down", !.observed = helper.epoch, !.slot = 0,
          !.gen = IF helper.phase = "crashed" THEN @ + 1 ELSE @]
    /\ conn' = IF helper.phase = "crashed" /\ Remote /\ conn.host # 0 THEN RevokeHost ELSE conn
    /\ LET settled == IF helper.phase = "crashed" /\ ~Remote
                      THEN FailWhere({p \in Calls : calls[p].bridge = helper.gen}) ELSE calls
       IN calls' = IF helper.slot = 0 THEN settled ELSE [settled EXCEPT ![helper.slot].phase = "retired"]
    /\ UNCHANGED <<generation, evals, ref, audit>>

\* Stable states can stutter after the finite supplies of work are exhausted.
Next == Invalidate \/ Connect \/ StartHelper \/ HostDisconnect \/ LeaseExpiry
        \/ LinkChange("silent") \/ LinkChange("lost") \/ Tick \/ Heartbeat
        \/ ClientNotice \/ Crash \/ ForceKill \/ ProcessExit \/ ObserveExit
        \/ (\E e \in Evals : Submit(e) \/ Start(e) \/ Finish(e))
        \/ (\E c \in Calls : Send(c) \/ Accept(c) \/ Dispatch(c) \/ Apply(c)
              \/ Reply(c) \/ Deliver(c) \/ NativeDeadline(c) \/ ClientDeadline(c)
              \/ (\E owner \in Evals, op \in {"observe", "mutate"} : Queue(c, owner, op)))
        \/ \E s \in Sessions : Confirm(s) \/ SocketDeadline(s)

Spec == Init /\ [][Next]_vars
        /\ WF_vars(HostDisconnect) /\ WF_vars(Tick) /\ WF_vars(LeaseExpiry) /\ WF_vars(ClientNotice)
        /\ WF_vars(ForceKill) /\ WF_vars(ProcessExit) /\ WF_vars(ObserveExit)

Serialized == Cardinality(Active) <= 1
    /\ {c \in Calls : calls[c].phase = "native"} = (IF helper.slot = 0 THEN {} ELSE {helper.slot})
    /\ conn.host \in 0..MaxSessions /\ Cardinality(Waiting) <= 1
    /\ (conn.host = 0 \/ Cardinality({c \in Calls : calls[c].session = conn.host
                     /\ calls[c].phase \in {"accepted", "native"}}) <= 1)

GenerationsFenced == audit.dispatch /\ audit.delivery
    /\ \A e \in Evals : evals[e].state \in {"queued", "active"} => evals[e].gen = generation

RetirementFenced == (IF helper.phase = "down" THEN helper.observed = helper.epoch
                     ELSE helper.observed = helper.epoch - 1)
    /\ \A s \in Sessions : conn.retirement[s] = "confirmed" =>
                             s # conn.host /\ helper.observed >= conn.waitFor[s]

NoReplayOrDoubleSettlement == \A c \in Calls :
    /\ calls[c].dispatches <= 1 /\ calls[c].settlements <= 1
    /\ (calls[c].outcome = "none") <=> (calls[c].settlements = 0)

StaleReferencesFenced == \A c \in Calls :
    (calls[c].epoch # 0 /\ calls[c].ax \notin {0, calls[c].epoch}) =>
    ~calls[c].applied /\ calls[c].reply # "ok" /\ calls[c].outcome # "ok"

StoppingEventuallyObserved ==
    (helper.phase \in Stopping) ~> (helper.observed = helper.epoch)

LostSessionEventuallyRevoked ==
    (conn.host # 0 /\ conn.link \in {"fin", "lost", "silent"}) ~> (conn.host = 0)

RevokedCalls == {c \in Calls : Open(c) /\ calls[c].session # 0 /\ calls[c].session # conn.host}
RevokedCallsEventuallySettle == (RevokedCalls # {}) ~> (RevokedCalls = {})
=============================================================================

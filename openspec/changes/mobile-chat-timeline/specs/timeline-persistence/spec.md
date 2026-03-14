## ADDED Requirements

### Requirement: IndexedDB timeline database
The system SHALL provide a `TimelineDB` class in `web/src/timeline-db.ts` using IndexedDB database named `codedeck-timeline` with an `events` object store. Key path SHALL be `eventId`. Indexes SHALL include `[sessionId, epoch, seq]` (compound) and `[sessionId, ts]`.

#### Scenario: Database creation
- **WHEN** `TimelineDB` is instantiated for the first time
- **THEN** the IndexedDB database and indexes SHALL be created

### Requirement: Event storage
The `TimelineDB` SHALL provide `putEvent(event: TimelineEvent)` that stores a single event, and `putEvents(events: TimelineEvent[])` for batch inserts. Duplicate `eventId` values SHALL overwrite (idempotent).

#### Scenario: Store single event
- **WHEN** `putEvent` is called with a TimelineEvent
- **THEN** the event SHALL be persisted in IndexedDB

#### Scenario: Duplicate event idempotent
- **WHEN** `putEvent` is called twice with the same `eventId`
- **THEN** only one record SHALL exist in the store

### Requirement: Epoch-aware event queries
The `TimelineDB` SHALL provide `getEvents(sessionId, epoch, opts?)` that returns events filtered by sessionId AND epoch, ordered by seq. Options SHALL include `limit` (max events to return) and `afterSeq` (return only events with seq > afterSeq).

#### Scenario: Query by session and epoch
- **WHEN** `getEvents("session1", 1000, { limit: 200 })` is called
- **THEN** only events for session1 with epoch=1000 SHALL be returned, ordered by seq ascending, max 200

#### Scenario: Incremental query
- **WHEN** `getEvents("session1", 1000, { afterSeq: 50 })` is called
- **THEN** only events with seq > 50 SHALL be returned

### Requirement: Last seq and epoch tracking
The `TimelineDB` SHALL provide `getLastSeqAndEpoch(sessionId)` that returns the highest `{ seq, epoch }` for a given session, or `null` if no events exist.

#### Scenario: Get last seq
- **WHEN** session has events with max seq=150 and epoch=1000
- **THEN** `getLastSeqAndEpoch` SHALL return `{ seq: 150, epoch: 1000 }`

#### Scenario: No events for session
- **WHEN** session has no stored events
- **THEN** `getLastSeqAndEpoch` SHALL return `null`

### Requirement: Epoch cleanup
The `TimelineDB` SHALL provide `clearSessionEpoch(sessionId, epoch)` that removes all events for a given session with a specific epoch. This is used when daemon restart is detected (epoch mismatch).

#### Scenario: Clear old epoch data
- **WHEN** `clearSessionEpoch("session1", 1000)` is called
- **THEN** all events for session1 with epoch=1000 SHALL be removed
- **THEN** events for session1 with other epochs SHALL remain

### Requirement: Event pruning
The `TimelineDB` SHALL provide `pruneOldEvents(sessionId, keepCount)` that removes the oldest events beyond `keepCount` for a session.

#### Scenario: Prune excess events
- **WHEN** session has 1000 events and `pruneOldEvents("session1", 500)` is called
- **THEN** the 500 oldest events SHALL be removed

### Requirement: Graceful degradation
If IndexedDB is unavailable or throws errors, the `TimelineDB` SHALL fall back to memory-only mode without crashing the application. A warning SHALL be logged once.

#### Scenario: IndexedDB unavailable
- **WHEN** IndexedDB open fails (e.g., private browsing restrictions)
- **THEN** the system SHALL operate with in-memory storage only and log a warning

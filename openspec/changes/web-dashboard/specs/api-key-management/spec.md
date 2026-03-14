## ADDED Requirements

### Requirement: Create API key
The system SHALL allow authenticated users to create API keys via `POST /api/auth/user/me/keys`. The request body MAY include an optional `label` string. The system SHALL generate a key in the format `deck_` followed by 32 random hex bytes, store only the SHA-256 hash in the `api_keys` table, and return the full key exactly once in the response.

#### Scenario: Create key with label
- **WHEN** authenticated user sends `POST /api/auth/user/me/keys` with body `{ "label": "my-laptop" }`
- **THEN** system returns `{ id, apiKey: "deck_...", label: "my-laptop", createdAt }` with status 201

#### Scenario: Create key without label
- **WHEN** authenticated user sends `POST /api/auth/user/me/keys` with empty body
- **THEN** system returns `{ id, apiKey: "deck_...", label: null, createdAt }` with status 201

#### Scenario: Unauthenticated request
- **WHEN** request has no valid JWT or API key
- **THEN** system returns 401

### Requirement: List API keys
The system SHALL allow authenticated users to list their API keys via `GET /api/auth/user/me/keys`. The response SHALL include id, label, created_at, and revoked_at for each key. The response SHALL NOT include the raw key or its hash.

#### Scenario: User has keys
- **WHEN** authenticated user sends `GET /api/auth/user/me/keys`
- **THEN** system returns `{ keys: [{ id, label, createdAt, revokedAt }] }`

#### Scenario: User has no keys
- **WHEN** authenticated user with no keys sends `GET /api/auth/user/me/keys`
- **THEN** system returns `{ keys: [] }`

### Requirement: Revoke API key
The system SHALL allow authenticated users to revoke their own API keys via `DELETE /api/auth/user/me/keys/:keyId`. The system SHALL set `revoked_at` to the current timestamp. The system SHALL verify the key belongs to the requesting user.

#### Scenario: Revoke own key
- **WHEN** authenticated user sends `DELETE /api/auth/user/me/keys/:keyId` for a key they own
- **THEN** system sets `revoked_at` and returns 200

#### Scenario: Revoke another user's key
- **WHEN** authenticated user sends `DELETE /api/auth/user/me/keys/:keyId` for a key they do not own
- **THEN** system returns 404

#### Scenario: Key already revoked
- **WHEN** authenticated user sends `DELETE /api/auth/user/me/keys/:keyId` for an already-revoked key
- **THEN** system returns 200 (idempotent)

### Requirement: Web API Key Manager component
The web frontend SHALL render an ApiKeyManager component on the dashboard that displays all keys in a table, allows generating new keys with an optional label, shows the raw key exactly once after creation with a copy button and warning, and provides a revoke button per key.

#### Scenario: Generate and copy key
- **WHEN** user clicks "Generate Key", optionally enters a label, and confirms
- **THEN** the new key is displayed with a "Copy" button and a warning that it will not be shown again

#### Scenario: Revoke key from UI
- **WHEN** user clicks "Revoke" on a key row
- **THEN** the key is revoked and the list refreshes showing revoked status

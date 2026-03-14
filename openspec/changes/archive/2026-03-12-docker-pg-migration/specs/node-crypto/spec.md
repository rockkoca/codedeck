## ADDED Requirements

### Requirement: SHA-256 hashing
The system SHALL provide `sha256Hex(input: string): string` using Node.js `crypto.createHash('sha256')`.

#### Scenario: Hash computation
- **WHEN** `sha256Hex('hello')` is called
- **THEN** the same hex digest as Web Crypto's `crypto.subtle.digest('SHA-256')` is returned

### Requirement: Cryptographic random generation
The system SHALL provide `randomHex(bytes: number): string` using `crypto.randomBytes()`.

#### Scenario: Generate random hex
- **WHEN** `randomHex(32)` is called
- **THEN** a 64-character hex string of cryptographically secure random bytes is returned

### Requirement: JWT signing and verification
The system SHALL provide `signJwt()` and `verifyJwt()` using `crypto.createHmac('sha256', key)`, producing tokens compatible with the existing HMAC-SHA256 JWT format.

#### Scenario: Sign and verify roundtrip
- **WHEN** a JWT is signed with `signJwt({ sub: 'u1' }, key, 3600)`
- **THEN** `verifyJwt(token, key)` returns the payload with `sub: 'u1'`

#### Scenario: Expired token
- **WHEN** a JWT with `exp` in the past is verified
- **THEN** `verifyJwt()` returns `null`

#### Scenario: Tampered token
- **WHEN** a JWT payload is modified after signing
- **THEN** `verifyJwt()` returns `null`

### Requirement: AES-256-GCM encryption compatible with Web Crypto format
The system SHALL provide `encryptBotConfig()` and `decryptBotConfig()` using `crypto.createCipheriv('aes-256-gcm')`. The ciphertext format MUST be compatible with the existing Web Crypto format: `base64(iv[12] || ciphertext || authTag[16])`.

#### Scenario: Encrypt then decrypt roundtrip
- **WHEN** `encryptBotConfig(config, key)` is called, then `decryptBotConfig(result, key)` is called
- **THEN** the original config object is returned

#### Scenario: Decrypt data encrypted by Web Crypto
- **WHEN** data was encrypted by the old Web Crypto implementation (iv || ciphertext || tag, base64-encoded)
- **THEN** `decryptBotConfig()` with the same key successfully decrypts it

#### Scenario: Wrong key
- **WHEN** `decryptBotConfig()` is called with a different key
- **THEN** an error is thrown

### Requirement: Timing-safe comparison
The system SHALL provide `timingSafeEqual(a: string, b: string): boolean` using `crypto.timingSafeEqual()`.

#### Scenario: Equal strings
- **WHEN** `timingSafeEqual('abc', 'abc')` is called
- **THEN** `true` is returned in constant time

#### Scenario: Different strings
- **WHEN** `timingSafeEqual('abc', 'xyz')` is called
- **THEN** `false` is returned in constant time

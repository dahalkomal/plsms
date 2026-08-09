# PLSMS Security Specifications (Zero-Trust Validation)

This document addresses Phase 0 (Payload-First Security TDD) requirements. It defines core relational data invariants, outlines 12 malicious payloads ("Dirty Dozen") designed to break system laws, and provides a structural test specification to verify that security rules block unauthorized operations.

---

## 1. Core Data Invariants

1. **System Config Protection**: Only a `superuser` can modify `office_settings/settings`. Public or other staff can read settings, but cannot alter the address, footer, homepage banner, or logo.
2. **Citizen Read Access**: Anyone (unauthenticated) can query a license by its exact `licenseNumber` or `applicantId`. However, the public CANNOT perform an open list query to scrape or download the entire dataset of licenses.
3. **Role Enforcement**: User roles are verified by doing a dynamic database lookup inside `/users_roles/$(request.auth.uid)`. No user can create or update their own role document to escalate their privileges to `superuser` or `admin`.
4. **License Integrity**:
   - Fields such as `createdAt` and `applicantId` are immutable after document creation.
   - Timestamps `createdAt` and `updatedAt` must be set via secure server-side timestamps (`request.time`).
   - Standard office staff can change statuses but cannot bypass validations (e.g., status must conform strictly to `available`, `distributed`, `missing`, `found` values).
5. **No Blind Deletions**: Delections of records are strictly governed or completely disabled. Citizens cannot delete licenses or requests. Staff can process requests but not delete historical data.
6. **Atomic Search Counter**: Any citizen can trigger an increment on `statistics/search_served.totalSearchesServed`, but cannot modify it to an arbitrary value or decrease it.

---

## 2. The "Dirty Dozen" Malicious Payloads

These 12 malicious payloads attempt to violate security boundaries, bypass role-based restriction, poison values, or leak PII. Our Firestore security rules are designed to deny all of them.

### Payload 1: Super User Spoofing / Self-Grading Role
An authenticated attacker attempts to write a node in `/users_roles/` setting themselves as a "superuser".
```json
// Path: /users_roles/attacker_uid
{
  "email": "attacker@harmful.com",
  "role": "superuser"
}
```
*Expected Resolution*: `PERMISSION_DENIED` — Users cannot write or escalate their role without superuser auth.

### Payload 2: Dynamic Layout Poisoning / Public Office Settings Write
An unauthenticated or standard staff citizen attempts to overwrite the dynamic center configuration details of the system.
```json
// Path: /office_settings/settings
{
  "officeName": "Hacked Licensing Center",
  "officeAddress": "Malware Alley 101",
  "contactNumber": "999-999-999"
}
```
*Expected Resolution*: `PERMISSION_DENIED` — Only a genuine superuser can edit `office_settings`.

### Payload 3: Blanket License Scraping / Dataset scraping
An anonymous attacker tries to read some random list queries without exact criteria filters to dump the entire license base.
```json
// Query: db.collection("licenses").get() (unfiltered)
{}
```
*Expected Resolution*: `PERMISSION_DENIED` — Open listing without exact `licenseNumber` or `applicantId` search filters is disallowed.

### Payload 4: Arbitrary License Creation / Spoofed ID Insertion
A malicious guest user tries to upload their own custom forged driving license document directly into the system.
```json
// Path: /licenses/attacker_license_123
{
  "applicantId": "APP-666",
  "fullName": "Intruder Joe",
  "fatherHusbandName": "Hacker Senior",
  "licenseNumber": "DL-HACKED-777",
  "category": "LTV",
  "status": "available"
}
```
*Expected Resolution*: `PERMISSION_DENIED` — Only Staff/Admin can upload or insert driving licenses.

### Payload 5: Immutable Bypassing / Retroactive Name Mutation
A rogue staff member tries to update an existing driving license and change the immutable `applicantId` or `createdAt` values to manipulate physical histories.
```json
// Path: /licenses/license_doc_xyz
// Modifying existing document to change applicantId
{
  "applicantId": "NEW-APP-ID-HIJACK"
}
```
*Expected Resolution*: `PERMISSION_DENIED` — Verification helper enforces `incoming().applicantId == existing().applicantId`.

### Payload 6: Status Value Poisoning / Invalid State Injection
An authorized office worker attempts to inject an unsupported state code into a license record.
```json
// Path: /licenses/lic_456
{
  "status": "DESTROYED_BY_FIRE_OR_LOST" // Not in enum
}
```
*Expected Resolution*: `PERMISSION_DENIED` — Enums for status must strictly match `available`, `distributed`, `missing`, `found`.

### Payload 7: Timestamp Forgery
An intruder attempts to assign a custom false back-dated `createdAt` timestamp.
```json
// Path: /licenses/lic_789
{
  "createdAt": "1999-12-31T23:59:59Z"
}
```
*Expected Resolution*: `PERMISSION_DENIED` — Check forces timestamp to equate precisely to `request.time`.

### Payload 8: Public Notice Overwrite
A citizen tries to post a fake notification alerts onto the system notice board.
```json
// Path: /notices/fake_news_7
{
  "title": "OFFICE CLOSED FOR GOOD",
  "content": "Due to a complete system failure, please stay home indefinitely.",
  "createdAt": "2026-06-09T13:30:00Z",
  "active": true
}
```
*Expected Resolution*: `PERMISSION_DENIED` — Only Admins/Super Users are allowed to write or modify items in `notices/`.

### Payload 9: Collection Request Orphan Exploitation
An attacker attempts to link a Collection Request to a non-existent driving license document.
```json
// Path: /collection_requests/req_999
{
  "licenseId": "non_existent_fake_id_1122",
  "licenseHolderName": "No Body",
  "licenseNumber": "DL-000-00",
  "receiverName": "Scam Receiver",
  "phoneNumber": "+1234567890",
  "visitDay": "Monday",
  "status": "pending"
}
```
*Expected Resolution*: `PERMISSION_DENIED` — Schema/atomic checks mandate validation that referenced license ID genuinely exists using `exists()`.

### Payload 10: Collection Request State Promotion Hijacking
A citizen attempts to directly approve their own Collection Request from `pending` to `approved` or mark it `completed` without staff auditing.
```json
// Path: /collection_requests/req_abc
{
  "status": "approved"
}
```
*Expected Resolution*: `PERMISSION_DENIED` — State alterations are tiered; only staff can change status variables.

### Payload 11: Counter Vandalism / Search Count Reset
An anonymous visitor attempts to set the searchServed atomic counter back to zero or decrease it.
```json
// Path: /statistics/search_served
{
  "totalSearchesServed": 0
}
```
*Expected Resolution*: `PERMISSION_DENIED` — Only allowing atomic addition/increment (`request.resource.data.totalSearchesServed == resource.data.totalSearchesServed + 1`).

### Payload 12: Denial of Wallet Identifier Poisoning
An attacker attempts to push an enormous string (1.5MB) of junk symbolics as a document ID to crash parsing engines or inflate storage rates.
```json
// Path: /licenses/{10,000+ characters of binary garbage}
{
  "fullName": "Spammer"
}
```
*Expected Resolution*: `PERMISSION_DENIED` — `isValidId(id)` helper rejects anything exceeding 128 characters or matching unexpected syntax pattern.

---

## 3. Test Rules Enforcement Runner Model

The rules validation is targeted using the standard unit tests model which asserts that any attempt to push these malicious payloads returns permission failures.

Let's proceed directly with the design of our Zero-Trust `firestore.rules`.

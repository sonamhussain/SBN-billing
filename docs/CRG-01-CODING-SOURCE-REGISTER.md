# CRG-01 Coding Source Register

The authoritative regulatory sources behind CRG-01 (Medical Coding Release Governance, contract `CRG-CODESET-1`). An
entry records where a source came from, how the retrieved copy is fingerprinted, which clauses CRG-01 relies on, and
whether the entry has been approved. Clauses are paraphrased with their location; nothing here is invented or inferred
beyond the text. An entry that is not APPROVED is not a basis for activation: until then CRG-01 FINAL Checkpoint A uses
synthetic editions A and B only, imports no licensed catalogue, blocks no claim and does not hardcode the 2027
transition as verified law.

## SRC-01 — DHA General Circular GC 06-2026

| Field | Value |
|---|---|
| Identifier | GC 06-2026 (portal reference CIR-2026-00000200) |
| Issuer | Dubai Health Authority (DHA) |
| Type | External Circular |
| Issue date | 30 October 2026 (printed on page 1) |
| Subject | Update of Code Sets, DRG Payment Parameters, IR-DRG Grouper Version, and Payment Systems |
| Official circular page | https://services.dha.gov.ae/sheryan/wps/portal/home/circular-details?circularRefNo=CIR-2026-00000200&fromHome=true&isPublicCircular=true |
| Attachment | "View Document" on that page; portal document id `A5843C67-6CBF-C488-B15F-A18CE9200000`, served as `application/pdf`, `inline; filename="circular.pdf"`, 4 pages |
| Retrieved | 2026-11-04, from the official page above |
| Archived copy | `C:\Users\Dell\Documents\SBN_module\CRG-01_sources\DHA_GC_06-2026_circular.pdf` (206,526 bytes); not committed to the repository |
| SHA-256 of the archived copy | `3993f8678dc1273577c2437c075862b886fe9d587db0a574461ac4591dcfc082` |
| Fingerprint note | The portal serves each download encrypted with a fresh key and a fresh document `/ID`, so every download has different bytes and a different SHA-256 (three downloads: 206,289 to 206,674 bytes, same 4-page, 38-stream structure). The SHA-256 above identifies the archived copy only; it is not a stable identifier of the circular. |
| Language | Bilingual Arabic/English; page 4 states that the Arabic text prevails on any discrepancy |
| Approval status | **DRAFT** — recorded by the head developer; awaiting architecture-owner review and sign-off |
| Reviewer | — (not yet reviewed) |

### Clauses relied on by CRG-01 (paraphrased)

| Ref | Location | Requirement as stated | CRG-01 use |
|---|---|---|---|
| C1 | p.1, notification list | DHA notifies updates to the ICD-10-CM, CPT and HCPCS Level II code sets. | The three controlled code-system identities: `ICD-10-CM`, `CPT`, `HCPCS-LEVEL-II`. |
| C2 | p.2, "Code Set Updates", 1st paragraph | From 00:00 on 01 January 2027, providers must submit claims using the 2024 versions of the three code sets. | The edition boundary: the governing edition follows the date, never the newest release. |
| C3 | p.2, "Code Set Updates", 2nd paragraph | Claims with a Date of Service on or after that date use the 2024 versions; resubmissions, reconciliations and adjustments for a Date of Service before it keep the 2021 versions, regardless of submission date. | Resolution uses `Encounter.serviceDate` only (CRG-T01–T03). |
| C4 | p.2, "Code Set Updates", 3rd paragraph | The 2024 versions are available on e-ClaimLink for preparation and testing. | The future source of real release contents; not used in Checkpoint A. |
| C5 | p.2, "Code Set Updates", 4th paragraph | The CPT and HCPCS Level II licence is limited to health insurance claims processing within the DHA-regulated environment; other uses (internal HIS platforms, clinical documentation) need separate authorisation from the rights holders. | No licensed descriptor text is stored; real CPT/HCPCS contents wait for a licensing decision (see the rights table below). |
| C6 | p.3, closing paragraph | The circular takes effect from 00:00 on 01 January 2027. | Recorded only; not hardcoded as verified law while this entry is DRAFT. |
| C7 | p.4, footer | The Arabic text prevails over the English text. | The Arabic clauses must be checked by the reviewer before approval. |

### Rights per code system

Rights are recorded per (jurisdiction, authority, code system). In the database they are numbered decisions in
`crg_code_system_rights`; the latest decision governs, and no decision means BLOCKED. No APPROVED decision exists for a
real authority, so no real catalogue can be selected. Every synthetic fixture uses its own synthetic authority.

| Code system | Jurisdiction / authority | Rights | Basis |
|---|---|---|---|
| ICD-10-CM | AE-DU / DHA | BLOCKED | Pending sign-off of SRC-01 and of the source of the release contents (C4). |
| CPT | AE-DU / DHA | BLOCKED | C5 limits the licence to claims processing in the DHA environment; needs a written licensing decision. |
| HCPCS-LEVEL-II | AE-DU / DHA | BLOCKED | C5, as for CPT. |

### Out of CRG-01 scope (recorded, not implemented)

- p.2: DRG payment parameters, DRG base rate and IR-DRG Grouper version 3.5.5 for inpatient and day-case claims with a Date of Service from 01 January 2027.
- p.3: orientation sessions, payment-system and reimbursement arrangements, and the procedural notices this circular supersedes.

CRG-01 has no DRG engine, price change or payment logic.

### Open points before approval

1. A reviewer must confirm the clause readings above against the Arabic text (C7).
2. A stable identifier for the circular is needed, because the downloaded bytes change on every retrieval. Options are the
   portal document id together with the issue date, or a hash of the extracted text.
3. The real release contents (C4) and the licence scope (C5) need separate sign-off before any real import; until then
   every rights row above stays BLOCKED (CRG-128).

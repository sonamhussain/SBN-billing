import { createHash } from 'node:crypto'
import { canonicalCode } from './coding-release.resolver.ts'
import { SOURCE_ROW_ID, type ImportRow } from './coding-release.types.ts'

// CRG-01 FINAL Checkpoint A (audit CRG-F02) — the two fingerprints of one release, kept apart and each independently
// verifiable:
//
//   - the SOURCE ARTIFACT fingerprint: SHA-256 of the original artifact bytes exactly as retrieved. It is the A3
//     edition's content hash (A3's own meaning: the hash of the retrieved content) and the import's source file
//     SHA-256;
//   - the MEMBERSHIP fingerprint: SHA-256 over the normalized membership rows, ordered by source row id, one line each,
//     `sourceRowId TAB code TAB sourceRowSha256 LF`. The database recomputes it at commit.
//
// The importer never trusts a declared hash: it hashes the artifact itself, reads every record from it, hashes each
// record's own bytes (sourceRowSha256) and normalizes its code. Anyone holding the archived artifact can therefore
// reproduce artifact → content hash, artifact → each row hash, and rows → membership fingerprint. The artifact bytes
// themselves are never stored (no licensed content). Pure: no clock, database or network.
//
// Only the synthetic format is readable in Checkpoint A. A real catalogue format (ICD-10-CM order files, CPT, HCPCS)
// needs its own approved, versioned reader and remains blocked pending source and licence approval.

export const ARTIFACT_FORMATS = ['CRG-SYNTHETIC-TSV-1'] as const
export type ArtifactFormat = (typeof ARTIFACT_FORMATS)[number]

// CRG-SYNTHETIC-TSV-1: UTF-8 text, one record per line, each line `sourceRowId TAB code` ended by LF (the last line
// too). No header, no empty line, no CR, no third field (a descriptor is never accepted). A record's bytes are its line
// without the LF.
export type ParsedArtifact = { sourceFileSha256: string; byteLength: number; rows: ImportRow[] }

export const sha256Hex = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

export function parseReleaseArtifact(format: ArtifactFormat, bytes: Buffer): { ok: true; value: ParsedArtifact } | { ok: false; message: string } {
  if (format !== 'CRG-SYNTHETIC-TSV-1') return { ok: false, message: 'the artifact format is not readable in this checkpoint' }
  if (bytes.length === 0) return { ok: false, message: 'the artifact is empty' }
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) return { ok: false, message: 'the artifact is not valid UTF-8' }
  if (!text.endsWith('\n')) return { ok: false, message: 'every artifact record ends with LF' }
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return { ok: false, message: 'the artifact carries a control character other than TAB and LF (a CR included)' }
  const rows: ImportRow[] = []
  const ids = new Set<string>()
  const codes = new Set<string>()
  const records = text.slice(0, -1).split('\n')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const fields = record.split('\t')
    if (fields.length !== 2) return { ok: false, message: `artifact record ${index + 1} must have exactly two fields (source row id, code)` }
    const [sourceRowId, rawCode] = fields
    if (!SOURCE_ROW_ID.test(sourceRowId)) return { ok: false, message: `artifact record ${index + 1} has no controlled source row id` }
    const code = canonicalCode(rawCode)
    if (!code) return { ok: false, message: `artifact record ${index + 1} has no canonical code value` }
    if (ids.has(sourceRowId)) return { ok: false, message: 'a source row id appears more than once in the artifact' }
    if (codes.has(code)) return { ok: false, message: 'a code appears more than once in the artifact' }
    ids.add(sourceRowId)
    codes.add(code)
    rows.push({ sourceRowId, code, sourceRowSha256: sha256Hex(record) })
  }
  return { ok: true, value: { sourceFileSha256: sha256Hex(bytes), byteLength: bytes.length, rows } }
}

// The membership fingerprint (see above). Byte order of source row ids, exactly as the database orders them (COLLATE "C").
export function membershipFingerprint(rows: readonly ImportRow[]): string {
  const lines = [...rows].sort((a, b) => (a.sourceRowId < b.sourceRowId ? -1 : a.sourceRowId > b.sourceRowId ? 1 : 0)).map((row) => `${row.sourceRowId}\t${row.code}\t${row.sourceRowSha256}\n`)
  return sha256Hex(lines.join(''))
}

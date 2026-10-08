import { formatDateOnly } from '../../shared/format/date.ts'
import { OutcomeBadge } from '../../shared/ui/OutcomeBadge.tsx'
import { findingLayers, type ValidationFinding } from './validation.types.ts'

// FE-04 — one run's immutable findings grouped by the backend's layer, in sequence order. Outcome, code
// and message are shown exactly as recorded; nothing is parsed or summarised into a verdict. Rule
// provenance is an advanced, read-only detail.

function Provenance({ finding }: { finding: ValidationFinding }) {
  const provenance = finding.ruleProvenance
  if (!provenance) return null
  return (
    <details className="mt-1 text-xs text-slate-500">
      <summary className="cursor-pointer text-[var(--sbn-accent)]">Rule provenance</summary>
      <dl className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
        <div>
          <dt className="inline">Business date: </dt>
          <dd className="inline">{formatDateOnly(provenance.businessDate)}</dd>
        </div>
        <div>
          <dt className="inline">Policy: </dt>
          <dd className="inline">
            {provenance.provenanceContractVersion} / {provenance.precedencePolicyVersion}
          </dd>
        </div>
        <div className="sm:col-span-2 break-all">
          <dt className="inline">Governing binding: </dt>
          <dd className="inline font-mono">{provenance.governingBindingId}</dd>
        </div>
        {finding.provenance.ruleVersionId && (
          <div className="sm:col-span-2 break-all">
            <dt className="inline">Rule version: </dt>
            <dd className="inline font-mono">{finding.provenance.ruleVersionId}</dd>
          </div>
        )}
        {provenance.historicalOnly && <div className="sm:col-span-2">Historical-only source</div>}
      </dl>
    </details>
  )
}

export function FindingList({ findings }: { findings: ValidationFinding[] }) {
  if (findings.length === 0) return <p className="text-sm text-slate-500">This run recorded no findings.</p>

  // Known layers first in their fixed order; any other layer the backend sends is kept, not dropped.
  const layers = [...findingLayers, ...new Set(findings.map((finding) => finding.layer).filter((layer) => !(findingLayers as readonly string[]).includes(layer)))]

  return (
    <div className="space-y-3">
      {layers.map((layer) => {
        const inLayer = findings.filter((finding) => finding.layer === layer)
        if (inLayer.length === 0) return null
        return (
          <div key={layer}>
            <h5 className="text-xs font-medium uppercase tracking-wide text-slate-500">{layer}</h5>
            <ul className="mt-1 divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
              {inLayer.map((finding) => (
                <li key={finding.id} className="px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-6 text-right text-xs tabular-nums text-slate-400">{finding.sequence}</span>
                    <OutcomeBadge value={finding.outcome} />
                    <span className="font-mono text-xs text-slate-700">{finding.findingCode}</span>
                  </div>
                  <p className="mt-1 pl-8 text-slate-700">{finding.message}</p>
                  {finding.fieldPath && <p className="pl-8 text-xs text-slate-400">{finding.fieldPath}</p>}
                  <div className="pl-8">
                    <Provenance finding={finding} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

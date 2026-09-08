export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { getDb, getClock } from '../../../src/runtime';
import { explainEmployee } from '../../../src/explain';
import { fetchSlots, fetchDeps, fetchRules } from '../../../src/reconcile';
import { buildEmployeeState } from '../../../src/state';
import { topoOrder } from '../../../src/cascade';
import { resolveEmployee } from '../../../src/resolver';
import { summarize } from '../../../src/explain-text';
import { AssignmentTimeline, type TimelineBand } from '../../components/Timeline';
import type { TraceNode } from '../../../src/predicate';
import type { EmployeeResolution, Rule, SlotResolution } from '../../../src/types';
import { SimulateForm, OverrideForm, RecordForm } from './client';

interface EmployeeRow {
  id: string;
  company_id: string;
  first_name: string;
  last_name: string;
  email: string;
}

interface RecordRow {
  department: string | null;
  location_state: string | null;
  location_country: string;
  employment_type: string;
  pay_type: string;
  tenure_start_date: string;
}

interface AssignmentRow {
  slot: string;
  target: string;
  winning_rule_id: string;
}

interface HistoryRow {
  slot: string;
  target: string;
  valid_lower: string;
  valid_upper: string | null;
  system_lower: string;
  system_upper: string | null;
}

interface TimelineRow {
  slot: string;
  target: string;
  winning_rule_id: string;
  explain_trace: unknown;
  valid_lower: string;
  valid_upper: string | null;
}

interface SlotRow { id: string; key: string; target_type: string; display_name: string }
interface TargetRow { id: string; target_type: string; display_name: string }

export default async function EmployeePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const db = await getDb();
  const now = getClock().now();
  const validAt = typeof sp.valid_at === 'string' ? new Date(sp.valid_at) : now;
  const systemAt = typeof sp.system_at === 'string' ? new Date(sp.system_at) : now;
  const { rows: employees } = await db.query<EmployeeRow>(
    'SELECT id, company_id, first_name, last_name, email FROM employees WHERE id = $1',
    [id],
  );
  const employee = employees[0];
  if (!employee) return <main className="p-8">Employee not found.</main>;

  const { rows: records } = await db.query<RecordRow>(
    `SELECT department, location_state, location_country, employment_type, pay_type, tenure_start_date::text AS tenure_start_date
     FROM employment_records
     WHERE employee_id = $1 AND company_id = $2 AND system @> $3::timestamptz AND valid @> $4::timestamptz`,
    [id, employee.company_id, systemAt.toISOString(), validAt.toISOString()],
  );
  const record = records[0];

  const { rows: assignments } = await db.query<AssignmentRow>(
    `SELECT s.key AS slot, at.display_name AS target, ra.winning_rule_id
     FROM resolved_assignments ra
     JOIN assignment_slots s ON s.id = ra.slot_id
     JOIN assignment_targets at ON at.id = ra.target_id
     WHERE ra.employee_id = $1 AND ra.company_id = $2
       AND ra.system @> $3::timestamptz AND ra.valid @> $4::timestamptz`,
    [id, employee.company_id, systemAt.toISOString(), validAt.toISOString()],
  );

  const { rows: history } = await db.query<HistoryRow>(
    `SELECT s.key AS slot, at.display_name AS target,
            lower(ra.valid)::text AS valid_lower, upper(ra.valid)::text AS valid_upper,
            lower(ra.system)::text AS system_lower, upper(ra.system)::text AS system_upper
     FROM resolved_assignments ra
     JOIN assignment_slots s ON s.id = ra.slot_id
     JOIN assignment_targets at ON at.id = ra.target_id
     WHERE ra.employee_id = $1 AND ra.company_id = $2
     ORDER BY lower(ra.system) DESC, s.key`,
    [id, employee.company_id],
  );

  const explain = await explainEmployee(db, employee.company_id, id, validAt, systemAt);

  // The timeline draws what was believed at systemAt: only rows whose system
  // range contains it. Scrubbing the header's system control redraws the bands
  // under the older belief — no new endpoint needed, the ranges already exist.
  const { rows: timelineRows } = await db.query<TimelineRow>(
    `SELECT s.key AS slot, at.display_name AS target, ra.winning_rule_id, ra.explain_trace,
            lower(ra.valid)::text AS valid_lower, upper(ra.valid)::text AS valid_upper
     FROM resolved_assignments ra
     JOIN assignment_slots s ON s.id = ra.slot_id
     JOIN assignment_targets at ON at.id = ra.target_id
     WHERE ra.employee_id = $1 AND ra.company_id = $2
       AND ra.system @> $3::timestamptz
     ORDER BY s.key, lower(ra.valid)`,
    [id, employee.company_id, systemAt.toISOString()],
  );

  // A live resolution at the same (valid, system) times, so the explain section
  // can name which rules were considered, which matched, which won, which were
  // shadowed — and surface unassigned exactly_one slots, which produce no
  // resolved_assignments row and therefore no stored trace.
  let resolution: EmployeeResolution | null = null;
  let rulesForWhy: Rule[] = [];
  try {
    const [slots2, deps, rules, state] = await Promise.all([
      fetchSlots(db, employee.company_id),
      fetchDeps(db, employee.company_id),
      fetchRules(db, employee.company_id, id, validAt, systemAt),
      buildEmployeeState(db, employee.company_id, id, validAt, systemAt),
    ]);
    rulesForWhy = rules;
    resolution = resolveEmployee(topoOrder(slots2, deps), rules, state, validAt);
  } catch {
    resolution = null; // no employment record at this instant
  }
  const ruleNameById = new Map(
    (resolution?.slots ?? []).flatMap((sr) => sr.considered.map((c) => [c.ruleId, c.ruleName] as const)),
  );

  const { rows: slots } = await db.query<SlotRow>(
    'SELECT id, key, target_type, display_name FROM assignment_slots WHERE company_id = $1 ORDER BY key',
    [employee.company_id],
  );
  const { rows: targets } = await db.query<TargetRow>(
    'SELECT id, target_type, display_name FROM assignment_targets WHERE company_id = $1 ORDER BY display_name',
    [employee.company_id],
  );
  const targetName = new Map(targets.map((t) => [t.id, t.display_name]));
  const slotIdByKey = new Map(slots.map((s) => [s.key, s.id]));

  return (
    <main className="p-8 max-w-4xl">
      <Link href="/" className="text-blue-600 hover:underline">&larr; Employees</Link>
      <h1 className="mt-4 text-2xl font-bold">{employee.first_name} {employee.last_name}</h1>
      <p className="text-gray-600">{employee.email}</p>

      {record && (
        <section className="mt-6 border rounded p-4">
          <h2 className="text-lg font-semibold">Current employment record</h2>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-gray-500">Department</dt><dd>{record.department ?? '—'}</dd>
            <dt className="text-gray-500">Location</dt><dd>{record.location_state ?? '—'}, {record.location_country}</dd>
            <dt className="text-gray-500">Employment type</dt><dd>{record.employment_type}</dd>
            <dt className="text-gray-500">Pay type</dt><dd>{record.pay_type}</dd>
            <dt className="text-gray-500">Tenure start</dt><dd>{record.tenure_start_date}</dd>
          </dl>
          <RecordForm
            companyId={employee.company_id}
            employeeId={id}
            record={record}
            targetNames={Object.fromEntries(targets.map((t) => [t.id, t.display_name]))}
            validAt={validAt}
            systemAt={systemAt}
          />
        </section>
      )}

      <section className="mt-6">
        <h2 className="text-lg font-semibold">Assignments (valid {validAt.toISOString().slice(0, 19)}Z · system {systemAt.toISOString().slice(0, 19)}Z)</h2>
        <ul className="mt-2 space-y-1">
          {assignments.map((a) => (
            <li key={`${a.slot}:${a.target}`} className="border rounded p-2 text-sm">
              <strong>{a.slot}</strong> → {a.target}
              {ruleNameById.get(a.winning_rule_id) && (
                <span className="text-gray-500"> (won by {ruleNameById.get(a.winning_rule_id)})</span>
              )}
            </li>
          ))}
          {assignments.length === 0 && <li className="text-gray-500 text-sm">No assignments resolved yet.</li>}
        </ul>
      </section>

      <SimulateForm companyId={employee.company_id} employeeId={id} validAt={validAt} systemAt={systemAt} targetNames={Object.fromEntries(targetName)} />

      <OverrideForm companyId={employee.company_id} employeeId={id} slots={slots} targets={targets} />

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Assignment history (all beliefs)</h2>
        <table className="mt-2 w-full text-xs border">
          <thead className="bg-gray-50">
            <tr>
              <th className="p-2 text-left">slot</th>
              <th className="p-2 text-left">target</th>
              <th className="p-2 text-left">valid</th>
              <th className="p-2 text-left">system</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h, i) => (
              <tr key={i} className="border-t">
                <td className="p-2">{h.slot}</td>
                <td className="p-2">{h.target}</td>
                <td className="p-2 font-mono">[{h.valid_lower}, {h.valid_upper ?? '∞'})</td>
                <td className="p-2 font-mono">[{h.system_lower}, {h.system_upper ?? '∞'})</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {timelineRows.length > 0 && (() => {
        // Axis: earliest assignment to ~2 years past now for open-ended rows —
        // far enough that a tenure anniversary (the transition the demo is
        // built around) is on screen.
        const min = Math.min(...timelineRows.map((r) => Date.parse(r.valid_lower)));
        const max = Math.max(
          ...timelineRows.map((r) => (r.valid_upper ? Date.parse(r.valid_upper) : now.getTime() + 731 * 86400000)),
          validAt.getTime(),
          systemAt.getTime(),
        );
        const bySlot = new Map<string, TimelineBand['segments']>();
        for (const r of timelineRows) {
          // One stored trace covers EVERY resolved target in a `many` slot, so
          // "first applied entry" picks the wrong rule for every segment but
          // one. Match this segment's own winning_rule_id; fall back to the raw
          // id so a miss reads as obviously wrong rather than plausibly wrong.
          const trace = r.explain_trace as { considered?: { status: string; ruleId: string; ruleName: string; trace: TraceNode }[] } | null;
          const winner = trace?.considered?.find((c) => c.ruleId === r.winning_rule_id);
          const seg: TimelineBand['segments'][number] = {
            target: r.target,
            ruleName: winner?.ruleName ?? r.winning_rule_id,
            from: r.valid_lower,
            to: r.valid_upper,
            summary: winner ? summarize(winner.trace) : '',
          };
          bySlot.set(r.slot, [...(bySlot.get(r.slot) ?? []), seg]);
        }
        const bands: TimelineBand[] = [...bySlot.entries()].map(([slot, segments]) => ({ slot, segments }));
        return (
          <section className="mt-8">
            <h2 className="text-lg font-semibold">Assignment timeline</h2>
            <AssignmentTimeline
              bands={bands}
              axisMin={min}
              axisMax={max}
              validAt={validAt.toISOString()}
              systemAt={systemAt.toISOString()}
            />
          </section>
        );
      })()}

      {resolution && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Explain</h2>
          {resolution.slots.some((sr) => sr.unassignedWarning) && (
            <div className="mt-2 rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-800">
              <strong>Unassigned slot{resolution.slots.filter((s) => s.unassignedWarning).length > 1 ? 's' : ''}:</strong>{' '}
              {resolution.slots.filter((s) => s.unassignedWarning).map((s) => s.slotKey).join(', ')}{' '}
              — declared <code>exactly_one</code> but no rule matched this employee.
            </div>
          )}
          <ul className="mt-3 space-y-3">
            {resolution.slots.map((sr) => (
              <li key={sr.slotKey} className="border rounded p-3 text-sm">
                <div>
                  <strong>{sr.slotKey}</strong>{' '}
                  <span className="text-gray-400">({sr.cardinality})</span>{' '}
                  {sr.resolved.length > 0 ? (
                    <span>→ {sr.resolved.map((r) => targetName.get(r.targetId) ?? r.targetId).join(', ')}</span>
                  ) : (
                    <span className={sr.unassignedWarning ? 'font-semibold text-amber-700' : 'text-gray-500'}>
                      → unassigned
                    </span>
                  )}
                </div>
                {(['applied', 'denied', 'shadowed', 'not_matched'] as const).map((status) => {
                  const group = sr.considered.filter((c) => c.status === status);
                  if (group.length === 0) return null;
                  const label = { applied: 'Applied', denied: 'Denied', shadowed: 'Shadowed', not_matched: 'Did not match' }[status];
                  return (
                    <div key={status} className="mt-1">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
                      <ul className="space-y-0.5 text-xs">
                        {group.map((c) => (
                          <li
                            key={c.ruleId}
                            className={
                              status === 'applied' ? 'text-green-700'
                              : status === 'denied' ? 'text-red-700'
                              : status === 'shadowed' ? 'text-gray-600'
                              : 'text-gray-400'
                            }
                          >
                            {status === 'applied' ? '✓ ' : status === 'denied' ? '✗ ' : '• '}
                            <strong>{c.ruleName}</strong> — {c.reason}.{' '}
                            <span className="italic">{summarize(c.trace)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
                <WhyNot
                  rules={rulesForWhy.filter((r) => r.slotId === slotIdByKey.get(sr.slotKey))}
                  resolution={sr}
                  targetName={targetName}
                />
              </li>
            ))}
          </ul>
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-gray-500">Raw stored trace</summary>
            <pre className="mt-2 overflow-auto rounded bg-gray-100 p-3 text-xs max-h-96">
              {JSON.stringify(explain, null, 2)}
            </pre>
          </details>
        </section>
      )}
    </main>
  );
}

/**
 * "Jane should have GitHub, why doesn't she?" — the inverse of the question the
 * brief asks, and the ticket an HR admin actually files. For every target this
 * slot could grant but didn't, name the rule and the condition that failed.
 * The resolver already produced every verdict; this only surfaces it.
 */
function WhyNot({
  rules,
  resolution,
  targetName,
}: {
  rules: Rule[];
  resolution: SlotResolution;
  targetName: Map<string, string>;
}) {
  const granted = new Set(resolution.resolved.map((r) => r.targetId));
  const byRuleId = new Map(resolution.considered.map((c) => [c.ruleId, c]));
  const byTarget = new Map<string, { ruleName: string; because: string }[]>();
  for (const r of rules) {
    if (r.effect !== 'grant' || granted.has(r.targetId)) continue;
    const c = byRuleId.get(r.ruleId);
    const because =
      c === undefined ? 'a manual override scoped to another employee'
      : c.status === 'not_matched' ? summarize(c.trace)
      : c.reason;
    byTarget.set(r.targetId, [...(byTarget.get(r.targetId) ?? []), { ruleName: r.name, because }]);
  }
  if (byTarget.size === 0) return null;
  return (
    <div className="mt-2 border-t pt-2">
      <div className="text-xs font-semibold text-gray-500">Why not…</div>
      <ul className="mt-1 space-y-1 text-xs text-gray-600">
        {[...byTarget.entries()].map(([targetId, reasons]) => (
          <li key={targetId}>
            <strong>{targetName.get(targetId) ?? targetId}</strong> is not assigned:
            <ul className="ml-4">
              {reasons.map((r, i) => (
                <li key={i}>under <em>{r.ruleName}</em>: {r.because}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

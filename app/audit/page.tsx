export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { getDb } from '../../src/runtime';

interface AuditRow {
  id: number;
  occurred_at: string;
  actor_kind: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
}

export default async function AuditPage() {
  const db = await getDb();
  const { rows: companies } = await db.query<{ id: string }>('SELECT id FROM companies ORDER BY name');
  const company = companies[0];
  if (!company) return <main className="p-8">No company.</main>;

  const { rows: events } = await db.query<AuditRow>(
    `SELECT id, occurred_at, actor_kind, action, entity_type, entity_id, before, after, reason
     FROM audit_events
     WHERE company_id = $1
     ORDER BY occurred_at DESC
     LIMIT 200`,
    [company.id],
  );

  return (
    <main className="p-8 max-w-4xl">
      <Link href="/" className="text-blue-600 hover:underline">&larr; Employees</Link>
      <h1 className="mt-4 text-2xl font-bold">Audit feed</h1>
      <table className="mt-4 w-full text-xs border">
        <thead className="bg-gray-50">
          <tr>
            <th className="p-2 text-left">time</th>
            <th className="p-2 text-left">actor</th>
            <th className="p-2 text-left">action</th>
            <th className="p-2 text-left">entity</th>
            <th className="p-2 text-left">details</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id} className="border-t align-top">
              <td className="p-2 font-mono whitespace-nowrap">{new Date(e.occurred_at).toISOString()}</td>
              <td className="p-2">{e.actor_kind}</td>
              <td className="p-2">{e.action}</td>
              <td className="p-2">{e.entity_type}{e.entity_id ? `:${String(e.entity_id).slice(0, 8)}` : ''}</td>
              <td className="p-2">
                <details>
                  <summary className="cursor-pointer text-gray-500">{e.reason ?? 'payload'}</summary>
                  <pre className="mt-1 overflow-auto rounded bg-gray-100 p-2">{JSON.stringify({ before: e.before, after: e.after }, null, 2)}</pre>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {events.length === 0 && <p className="mt-4 text-sm text-gray-500">No audit events yet.</p>}
    </main>
  );
}

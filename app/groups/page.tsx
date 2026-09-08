export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { getDb, getClock } from '../../src/runtime';
import { GroupForm, MemberForm } from './client';

interface GroupRow { id: string; key: string; kind: string; criteria: unknown }
interface MemberRow { group_key: string; first_name: string; last_name: string }
interface EmployeeRow { id: string; first_name: string; last_name: string }

export default async function GroupsPage() {
  const db = await getDb();
  const at = getClock().now();
  const { rows: companies } = await db.query<{ id: string }>('SELECT id FROM companies ORDER BY name');
  const company = companies[0];
  if (!company) return <main className="p-8">No company.</main>;

  const { rows: groups } = await db.query<GroupRow>(
    'SELECT id, key, kind, criteria FROM groups WHERE company_id = $1 ORDER BY key',
    [company.id],
  );
  const { rows: members } = await db.query<MemberRow>(
    `SELECT g.key AS group_key, e.first_name, e.last_name
     FROM group_memberships gm
     JOIN groups g ON g.id = gm.group_id
     JOIN employees e ON e.id = gm.employee_id
     WHERE gm.company_id = $1 AND gm.system @> $2::timestamptz AND gm.valid @> $2::timestamptz
     ORDER BY g.key, e.last_name`,
    [company.id, at.toISOString()],
  );
  const { rows: employees } = await db.query<EmployeeRow>(
    'SELECT id, first_name, last_name FROM employees WHERE company_id = $1 ORDER BY last_name',
    [company.id],
  );

  const membersByGroup = new Map<string, string[]>();
  for (const m of members) {
    membersByGroup.set(m.group_key, [...(membersByGroup.get(m.group_key) ?? []), `${m.first_name} ${m.last_name}`]);
  }

  return (
    <main className="p-8 max-w-3xl">
      <Link href="/" className="text-blue-600 hover:underline">&larr; Employees</Link>
      <h1 className="mt-4 text-2xl font-bold">Groups</h1>

      <ul className="mt-4 space-y-3">
        {groups.map((g) => (
          <li key={g.id} className="border rounded p-3 text-sm">
            <div className="font-medium">{g.key} <span className="text-gray-500">({g.kind})</span></div>
            {g.criteria != null ? <pre className="mt-1 text-xs text-gray-600 overflow-auto">{JSON.stringify(g.criteria)}</pre> : null}
            <p className="mt-1 text-gray-600">
              static members: {(membersByGroup.get(g.key) ?? []).join(', ') || '—'}
            </p>
          </li>
        ))}
      </ul>

      <GroupForm companyId={company.id} />
      <MemberForm companyId={company.id} groups={groups} employees={employees} />
    </main>
  );
}

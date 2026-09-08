import { z } from 'zod';
import { toSql, type Predicate, type SqlFragment } from './predicate';
import type { Clock } from './clock';
import type { Db } from './db';

const predicateSchema = z.object({ op: z.string() }).loose();

export interface AuthorRuleResult {
  name: string;
  criteria: Predicate;
  sqlPreview: SqlFragment;
}

export async function authorRule(
  db: Db,
  companyId: string,
  description: string,
  clock: Clock,
): Promise<AuthorRuleResult> {
  let criteria: Predicate;
  if (process.env.ANTHROPIC_API_KEY) {
    criteria = await callAnthropic(description);
  } else {
    criteria = heuristicAuthor(description);
  }
  predicateSchema.parse(criteria);
  const sqlPreview = toSql(criteria, clock.now(), []);
  return { name: description.slice(0, 80), criteria, sqlPreview };
}

async function callAnthropic(description: string): Promise<Predicate> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY as string,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Given this employee-assignment rule description, output a single JSON predicate using this DSL: {"op":"always"} | {"op":"eq"|"neq","field":"department|location_state|location_country|employment_type|pay_type","value":"..."} | {"op":"gte_tenure","years":N} | {"op":"in_group","group_key":"..."} | {"op":"is_manager"} | {"op":"and"|"or","children":[...]} | {"op":"not","child":{...}}. Description: ${description}. Output only the JSON predicate, no markdown.`,
        },
      ],
    }),
  });
  const data = await res.json() as { content?: { text?: string }[] };
  const text = data.content?.[0]?.text ?? '{"op":"always"}';
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) as Predicate;
}

function heuristicAuthor(description: string): Predicate {
  const d = description.toLowerCase();
  if (/tenure|years?/.test(d)) {
    const m = d.match(/(\d+)\s*years?/);
    return { op: 'gte_tenure', years: m ? Number(m[1]) : 1 };
  }
  if (/manager/.test(d)) return { op: 'is_manager' };
  if (/engineering/.test(d)) return { op: 'eq', field: 'department', value: 'Engineering' };
  if (/sales/.test(d)) return { op: 'eq', field: 'department', value: 'Sales' };
  if (/\b(ca|california)\b/.test(d)) return { op: 'eq', field: 'location_state', value: 'CA' };
  if (/\b(ny|new york)\b/.test(d)) return { op: 'eq', field: 'location_state', value: 'NY' };
  if (/hourly/.test(d)) return { op: 'eq', field: 'pay_type', value: 'hourly' };
  if (/contractor/.test(d)) return { op: 'eq', field: 'employment_type', value: 'contractor' };
  return { op: 'always' };
}

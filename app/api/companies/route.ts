import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '../../../src/runtime';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const db = await getDb();
  const { rows } = await db.query<{ id: string }>('INSERT INTO companies (name) VALUES ($1) RETURNING id', [body.name]);
  return NextResponse.json({ id: rows[0].id });
}

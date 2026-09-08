import type { Slot, SlotDependency } from './types';

function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

function topo(slots: Slot[], deps: SlotDependency[]): Slot[] {
  const slotById = new Map(slots.map((s) => [s.id, s]));
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const slot of slots) {
    inDegree.set(slot.id, 0);
    adj.set(slot.id, []);
  }

  const seen = new Set<string>();
  for (const dep of deps) {
    if (!slotById.has(dep.slotId) || !slotById.has(dep.dependsOnSlotId)) {
      continue;
    }
    const key = `${dep.dependsOnSlotId}->${dep.slotId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    inDegree.set(dep.slotId, (inDegree.get(dep.slotId) ?? 0) + 1);
    const list = adj.get(dep.dependsOnSlotId) ?? [];
    list.push(dep.slotId);
    adj.set(dep.dependsOnSlotId, list);
  }

  const queue = sortById(slots.filter((s) => (inDegree.get(s.id) ?? 0) === 0));
  const order: Slot[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);

    const dependents = sortById(
      (adj.get(current.id) ?? []).map((id) => slotById.get(id)!).filter(Boolean),
    );
    for (const dependent of dependents) {
      const nextDegree = (inDegree.get(dependent.id) ?? 1) - 1;
      inDegree.set(dependent.id, nextDegree);
      if (nextDegree === 0) {
        queue.push(dependent);
        queue.sort((a, b) => a.id.localeCompare(b.id));
      }
    }
  }

  if (order.length !== slots.length) {
    throw new Error('slot dependency graph contains a cycle');
  }

  return order;
}

export function validateSlotGraph(deps: SlotDependency[]): void {
  const slotIds = new Set<string>();
  for (const d of deps) {
    slotIds.add(d.slotId);
    slotIds.add(d.dependsOnSlotId);
  }
  const fakeSlots: Slot[] = [...slotIds].map((id) => ({
    id,
    companyId: '',
    key: id,
    displayName: id,
    cardinality: 'exactly_one',
    targetType: 'policy',
  }));
  topo(fakeSlots, deps);
}

export function topoOrder(slots: Slot[], deps: SlotDependency[]): Slot[] {
  return topo(slots, deps);
}

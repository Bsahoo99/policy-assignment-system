import { describe, it, expect } from 'vitest';
import { validateSlotGraph, topoOrder } from '../src/cascade';
import type { Slot, SlotDependency } from '../src/types';

function slot(id: string): Slot {
  return {
    id,
    companyId: 'c',
    key: id,
    displayName: id,
    cardinality: 'exactly_one',
    targetType: 'policy',
  };
}

describe('cascade', () => {
  it('test_slot_graph_with_cycle_raises_error', () => {
    const deps: SlotDependency[] = [
      { companyId: 'c', slotId: 'a', dependsOnSlotId: 'b' },
      { companyId: 'c', slotId: 'b', dependsOnSlotId: 'a' },
    ];
    expect(() => validateSlotGraph(deps)).toThrow(/cycle/);
  });

  it('test_topo_order_places_dependency_before_dependent', () => {
    const slots = [slot('training'), slot('manager')];
    const deps: SlotDependency[] = [{ companyId: 'c', slotId: 'training', dependsOnSlotId: 'manager' }];
    const order = topoOrder(slots, deps).map((s) => s.id);
    expect(order.indexOf('manager')).toBeLessThan(order.indexOf('training'));
  });
});

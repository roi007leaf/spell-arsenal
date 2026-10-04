import test from 'node:test';
import assert from 'node:assert/strict';
import { dnd5eAdapter } from '../scripts/dnd5e.js';

test('automatic D&D placement damage bypasses configuration without replacing native rolls', async () => {
  globalThis.game = { messages: new Map() };
  const calls = [];
  const activity = { id: 'save', type: 'save', damage: { parts: [{}] },
    rollDamage: async (...args) => { calls.push(args); return ['native damage']; } };
  const spell = { system: { activities: { save: activity } } };
  const result = await dnd5eAdapter.areaCastActions(spell, { flags: {} })[0].run();
  assert.deepEqual(calls, [[{}, { configure: false }]]);
  assert.deepEqual(result, ['native damage']);
});

test('explicit D&D damage actions retain native configuration', async () => {
  const calls = [];
  const activity = { id: 'damage', type: 'damage', damage: { parts: [{}] },
    rollDamage: async (...args) => calls.push(args) };
  const spell = { system: { activities: { damage: activity } } };
  await dnd5eAdapter.areaActions(spell, { actor: {} }, 'entry')[0].run();
  assert.deepEqual(calls, [[]]);
});

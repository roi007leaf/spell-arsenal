import test from 'node:test';
import assert from 'node:assert/strict';
import { rollAreaPlacement, areaEnemyTokens } from '../scripts/area-automation.js';
import { pf2eAdapter } from '../scripts/pf2e.js';
import { dnd5eAdapter } from '../scripts/dnd5e.js';
import { wizardHandlesAreaAutomation } from '../scripts/template-wizard.js';

test('placement targets all covered enemies and rolls damage once, keeping allies and outsiders out', async () => {
  for (const system of ['pf2e', 'dnd5e']) {
    const events = [];
    const actor = { id: 'caster' };
    const damage = async event => { events.push('damage'); if (system === 'pf2e') assert.ok(event instanceof Event); return {}; };
    const spell = { type: 'spell', name: 'Fireball', actor, damageKinds: new Set(['damage']), rollDamage: damage, system: system === 'pf2e' ? {} : { level: 3, activities: { damage: { id: 'damage', type: 'save', damage: { parts: [{}] }, rollDamage: damage } } } };
    const makeToken = (id, disposition, covered = true, ownActor = { id }) => ({ id, uuid: `Token.${system}.${id}`, name: id, disposition, actor: ownActor, testInsideRegion: () => covered });
    const tokens = [makeToken('caster', 1, false, actor), makeToken('enemy1', -1), makeToken('enemy2', -1), makeToken('ally', 1), makeToken('neutral', 0), makeToken('outside', -1, false)];
    const region = { id: 'r', uuid: `Region.${system}.placement`, message: { item: spell }, flags: system === 'dnd5e' ? { dnd5e: { item: 'Item.fireball' } } : {}, parent: { tokens, regions: new Map([['r', {}]]) } };
    globalThis.fromUuidSync = () => spell;
    globalThis.game = { system: { id: system }, modules: new Map(), user: { id: 'gm', isGM: true }, users: { activeGM: { id: 'gm' } }, settings: { get: (_id, key) => key === 'enabled' ? true : [{ enabled: true, spell: 'Fireball', kind: 'area', areaAutomation: 'placement-entry' }] } };
    globalThis.canvas = { tokens: { setTargets: (ids, options) => { assert.equal(options.mode, 'replace'); events.push(ids); } } };
    globalThis.foundry = { applications: { api: { DialogV2: { wait: async () => { throw Error('damage must not be prompted again'); } } } } };
    const get = game.settings.get;
    game.settings.get = (id, key) => key === 'autoRollDamage' ? false : get(id, key);
    await rollAreaPlacement(region);
    assert.deepEqual(events, [['enemy1', 'enemy2']]);
    events.length = 0;
    game.settings.get = (id, key) => key === 'autoRollDamage' ? true : get(id, key);
    assert.deepEqual(areaEnemyTokens(region, spell).map(t => t.id), ['enemy1', 'enemy2']);
    await rollAreaPlacement(region);
    await rollAreaPlacement(region);
    assert.deepEqual(events, [['enemy1', 'enemy2'], 'damage']);
  }
});

test('native attack takes precedence over damage in both adapters', async () => {
  const calls = [];
  const pf = { isAttack: true, damageKinds: new Set(['damage']), rollAttack: async event => { assert.ok(event instanceof Event); calls.push('pf attack'); }, rollDamage: () => { throw Error('premature damage'); } };
  await pf2eAdapter.areaCastActions(pf)[0].run();
  const attack = { id: 'attack', type: 'attack', damage: { parts: [{}] }, rollAttack: async () => calls.push('5e attack'), rollDamage: () => { throw Error('premature damage'); } };
  const dnd = { system: { activities: { attack } } };
  globalThis.game = { messages: new Map() };
  await dnd5eAdapter.areaCastActions(dnd, { flags: {} })[0].run();
  assert.deepEqual(calls, ['pf attack', '5e attack']);
});

test('PF2e spell damage uses native damageKinds; healing never triggers damage or a spell repost', async () => {
  let rolls = 0;
  const spell = { type: 'spell', damageKinds: new Set(['damage']), rollDamage: async event => { assert.ok(event instanceof Event); rolls++; }, toMessage: () => { throw Error('duplicate spell card'); } };
  assert.equal(spell.dealsDamage, undefined);
  const cast = pf2eAdapter.areaCastActions(spell);
  assert.equal(cast.length, 1);
  await cast[0].run();
  assert.equal(pf2eAdapter.areaActions(spell, { actor: {} }).length, 1);
  spell.damageKinds = new Set(['healing']);
  assert.deepEqual(pf2eAdapter.areaCastActions(spell), []);
  assert.deepEqual(pf2eAdapter.areaActions(spell, { actor: {} }), []);
  assert.equal(rolls, 1);
});

test('5e ambiguous activities require original cast activity instead of rolling every activity', () => {
  const activity = id => ({ id, type: 'save', damage: { parts: [{}] }, rollDamage: () => {} });
  const spell = { system: { activities: { first: activity('first'), second: activity('second') } } };
  globalThis.game = { messages: new Map() };
  assert.deepEqual(dnd5eAdapter.areaCastActions(spell, { flags: {} }), []);
  assert.equal(dnd5eAdapter.areaCastActions(spell, { flags: { dnd5e: { activityId: 'second' } } }).length, 1);
});

test('PF2e placement uses actor alliance with neutral tokens and waits for region coverage', async () => {
  const events = [];
  const actor = { id: 'caster', isEnemyOf: other => other.alliance === 'opposition' };
  const spell = { type: 'spell', name: 'Fireball', actor, damageKinds: new Set(['damage']), rollDamage: async () => events.push('damage'), system: {} };
  let coverageReady = false;
  const caster = { id: 'caster', actor, disposition: 0, testInsideRegion: () => false };
  const enemy = { id: 'enemy', uuid: 'Token.enemy', actor: { id: 'enemy', alliance: 'opposition' }, disposition: 0, testInsideRegion: () => coverageReady };
  const region = { id: 'r', uuid: 'Region.delayed', message: { item: spell }, parent: { id: 'scene', tokens: [caster, enemy], regions: new Map([['r', {}]]) } };
  globalThis.game = { system: { id: 'pf2e' }, modules: new Map(), user: { id: 'gm', isGM: true }, users: { activeGM: { id: 'gm' } }, settings: { get: (_id, key) => key === 'enabled' ? true : [{ enabled: true, spell: 'Fireball', kind: 'area', areaAutomation: 'placement-entry' }] } };
  globalThis.canvas = { tokens: { setTargets: ids => events.push(ids) } };
  setTimeout(() => { coverageReady = true; }, 20);
  await rollAreaPlacement(region);
  assert.deepEqual(events, [['enemy'], 'damage']);
  coverageReady = false;
  await rollAreaPlacement({ ...region, uuid: 'Region.no-enemies' });
  assert.deepEqual(events.slice(2), [[], 'damage']);
});

test('Wizard geometry alone does not suppress rolls; real save or damage behaviors delegate', () => {
  const automation = { enabled: true, templateShape: { shapes: [{ type: 'circle', size: 20 }] }, behaviors: [] };
  globalThis.game = { modules: new Map([['pf2e-aztecs-template-wizard', { active: true, api: { readAutomation: () => automation } }]]) };
  assert.equal(wizardHandlesAreaAutomation({}), false);
  automation.behaviors.push({ type: 'savingThrow' });
  assert.equal(wizardHandlesAreaAutomation({}), true);
  automation.behaviors = [{ type: 'dealDamage' }];
  assert.equal(wizardHandlesAreaAutomation({}), true);
});

test('successful instant damage deletes source; lasting areas and cancelled rolls remain in both systems', async () => {
  for (const system of ['pf2e', 'dnd5e']) for (const [instant, result] of [[true, {}], [false, {}], [true, null], [true, []]]) {
    let deleted = 0;
    const actor = { id: 'caster' };
    const spell = { type: 'spell', name: 'Fireball', actor, damageKinds: new Set(['damage']), rollDamage: async () => result, system: system === 'pf2e' ? {} : { level: 3, activities: { damage: { id: 'damage', type: 'save', damage: { parts: [{}] }, rollDamage: async () => result } } } };
    const tokens = [{ id: 'caster', actor, disposition: 1, testInsideRegion: () => false }, { id: 'enemy', uuid: 'Token.cleanup-enemy', actor: { id: 'enemy' }, disposition: -1, testInsideRegion: () => true }];
    const region = { id: 'r', uuid: `Region.cleanup.${system}.${instant}.${JSON.stringify(result)}`, message: { item: spell }, flags: system === 'dnd5e' ? { dnd5e: { item: 'Item.spell' } } : {}, parent: { tokens, regions: new Map([['r', {}]]) }, delete: async () => { deleted++; } };
    globalThis.fromUuidSync = () => spell;
    globalThis.game = { system: { id: system }, modules: new Map(), user: { id: 'gm', isGM: true }, users: { activeGM: { id: 'gm' } }, settings: { get: (_id, key) => key === 'enabled' ? true : [{ enabled: true, spell: 'Fireball', kind: 'area', areaAutomation: 'placement-entry', instant, duration: instant ? 0 : 60 }] } };
    globalThis.canvas = { tokens: { setTargets: () => {} } };
    await rollAreaPlacement(region);
    assert.equal(deleted, instant && result && !Array.isArray(result) ? 1 : 0);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as nodeModule from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
nodeModule.registerHooks?.({ load(url, context, nextLoad) {
  return nextLoad(url, url.includes('/spell-arsenal/scripts/') ? { ...context, format: 'module' } : context);
} });
class Collection extends Map { [Symbol.iterator]() { return this.values(); } }
const hooks = new Map();
let serial = 0;
globalThis.Hooks = {
  on(name, callback) { const id = ++serial; const list = hooks.get(name) ?? new Map(); list.set(id, callback); hooks.set(name, list); return id; },
  off(name, id) { hooks.get(name)?.delete(id); },
  callAll(name, ...args) { for (const callback of hooks.get(name)?.values() ?? []) callback(...args); }
};
const scene = { id: 'scene', regions: new Collection(), tokens: new Collection(), getEmbeddedCollection: () => [], deleteEmbeddedDocuments: async () => {} };
const actor = { id: 'caster', isEnemyOf: other => other.id === 'enemy' };
const spell = { type: 'spell', name: 'Caustic Blast', actor, rank: 1, system: { area: { type: 'burst', value: 5 } } };
let played = [];
let errors = [];
const recipe = { name: spell.name };
const api = { resolve: () => recipe, play: async (selected, context) => { played.push({ recipe: selected, context }); } };
globalThis.game = { user: { id: 'gm', isGM: true, targets: new Set() }, users: { activeGM: { id: 'gm' } }, scenes: [scene], system: { id: 'pf2e' }, messages: new Map(),
  modules: new Map([['animater', { active: true, api }], ['tile-arsenal', { active: true }]]), settings: { get: () => false } };
globalThis.canvas = { ready: true, scene, level: { id: 'level', elevation: { base: 0 } }, grid: { isGridless: false }, tokens: { placeables: [] } };
globalThis.ui = { notifications: { error: message => { errors.push(message); } } };
globalThis.tileArsenal = { utils: { getConfigurations: async () => ({ configurations: { acid: { name: 'Acid', configs: { tile: { stage: 1, type: 'Tile' } }, toDocumentData() {} } } }) } };
globalThis.CONST = { REGION_VISIBILITY: { LAYER: 1 } };
const { runSpellEffect } = await import('../scripts/runtime.js');
const { playAnimater, animationActivity } = await import('../scripts/animater-integration.js');
const { createTileArsenalNode } = await import('../scripts/trigger-integration.js');
const { registerAreaAutomation, rollAreaPlacement } = await import('../scripts/area-automation.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(id, optedIn = true) {
  played = []; errors = []; scene.regions.clear(); scene.tokens.clear();
  const source = { id: 'caster-token', actor, center: { x: 0, y: 0 }, document: { width: 1, height: 1, parent: scene } };
  const target = { id: 'enemy', uuid: 'Scene.scene.Token.enemy', actor: { id: 'enemy' }, parent: scene, testInsideRegion: () => true };
  target.object = { id: target.id, actor: target.actor, center: { x: 200, y: 200 }, document: target };
  scene.tokens.set(target.id, target);
  canvas.tokens.placeables = [source, target.object]; canvas.tokens.get = id => canvas.tokens.placeables.find(token => token.id === id);
  const runner = await runSpellEffect('area', { SPELL_NAME: spell.name, EFFECT_NAME: 'Acid', ANIMATER: optedIn, INSTANT: true, DURATION_SECONDS: 5, STAGE_MODE: 'auto' }, `spell-arsenal:${id}`);
  const message = { item: spell, speaker: { scene: scene.id, token: 'caster-token' } };
  const region = { id, uuid: `Scene.scene.Region.${id}`, documentName: 'Region', shapes: [{ type: 'circle', x: 200, y: 200, radius: 100 }], parent: scene, message, levels: new Set(['level']), elevation: { bottom: 0 },
    flags: { pf2e: { origin: { name: spell.name, castRank: 3 } } }, getCoverage: () => ({ covered: [{ i: 0, j: 0 }] }) };
  scene.regions.set(id, region);
  runner.createVisuals = async () => true;
  return { runner, region, target };
}

test('Caustic Blast animation survives Toolbelt removal during tile creation', async () => {
  const { runner, region } = await fixture('removed');
  const tiles = deferred();
  runner.createVisuals = () => tiles.promise;
  try {
    const rendering = runner.renderRegion(region);
    await flush();
    scene.regions.delete(region.id);
    tiles.resolve(true);
    await rendering;
    assert.equal(played.length, 1, 'Animater was suppressed, then skipped after source removal');
    assert.equal(played[0].context.template, region);
    assert.equal(played[0].context.actor, actor);
    assert.equal(played[0].context.tokenId, 'caster-token');
    assert.equal(played[0].context.castRank, 3);
  } finally { tiles.resolve(true); await runner.stop(false); }
});

test('region updates play Animater once, unchecked mapping never plays it', async () => {
  for (const optedIn of [true, false]) {
    const { runner, region } = await fixture(`updates-${optedIn}`, optedIn);
    try {
      Hooks.callAll('createRegion', region);
      Hooks.callAll('updateRegion', region, { shapes: [] });
      await flush(); await runner.queue;
      assert.equal(played.length, optedIn ? 1 : 0);
    } finally { await runner.stop(false); }
  }
});

test('Spell Arsenal tiles wait for Animater completion', async () => {
  const { runner, region } = await fixture('ordered');
  const playback = deferred();
  const original = api.play;
  let tiles = 0;
  api.play = async () => playback.promise;
  runner.createVisuals = async () => { tiles++; return true; };
  try {
    const rendering = runner.renderRegion(region);
    await flush();
    assert.equal(tiles, 0, 'Tile Arsenal started before Animater finished');
    playback.resolve();
    await rendering;
    assert.equal(tiles, 1);
  } finally { playback.resolve(); api.play = original; await runner.stop(false); }
});

test('absent enabled Animater recipe reports why it cannot play', async () => {
  api.resolve = () => null;
  try {
    await assert.rejects(playAnimater({ type: 'template', item: spell }), /No enabled Animater template recipe/);
    assert.deepEqual(played, []);
  } finally { api.resolve = () => recipe; }
});

test('playback trace distinguishes unavailable API, unresolved spell, and playback rejection', async () => {
  const module = game.modules.get('animater');
  const originalPlay = api.play;
  try {
    module.active = false;
    await assert.rejects(playAnimater({ type: 'template', item: spell }), /playback API unavailable/);
    assert.equal(animationActivity()[0].status, 'Blocked');
    module.active = true;
    await assert.rejects(playAnimater({ type: 'template' }), /source spell/);
    api.play = async () => { throw new Error('Native playback failure'); };
    await assert.rejects(playAnimater({ type: 'template', item: spell }), /Native playback failure/);
    assert.equal(animationActivity()[0].detail, 'Native playback failure');
    assert.equal(animationActivity()[1].status, 'Playing');
    const snapshot = animationActivity(); snapshot[0].status = 'Changed';
    assert.equal(animationActivity()[0].status, 'Blocked');
  } finally { module.active = true; api.play = originalPlay; }
});

test('placement trace identifies canvas level guard before Animater handoff', async () => {
  const { runner, region } = await fixture('wrong-level');
  region.levels = new Set(['other-level']);
  try {
    Hooks.callAll('createRegion', region);
    await flush(); await runner.queue;
    assert.equal(played.length, 0);
    assert.equal(animationActivity().find(entry => entry.source === region.uuid)?.detail, 'Area outside active canvas level');
  } finally { await runner.stop(false); }
});

test('disabled Trigger Animations entry also disables opted-in playback', async () => {
  const { runner, region } = await fixture('disabled-trigger');
  game.modules.set('trigger-animations', { active: true }); game.modules.set('trigger-engine', { active: true });
  game.settings.get = () => true;
  globalThis.triggerAnimations = { api: { matchTrigger: () => null, runFromTrigger: async () => assert.fail('Disabled entry dispatched') } };
  try {
    Hooks.callAll('createRegion', region);
    await flush(); await runner.queue;
    assert.equal(played.length, 0);
  } finally { game.settings.get = () => false; game.modules.delete('trigger-animations'); game.modules.delete('trigger-engine'); await runner.stop(false); }
});

test('enabled Trigger Animations graph plays once before queued tiles', async () => {
  const { runner, region } = await fixture('enabled-trigger');
  const earlier = deferred(); runner.submit(() => earlier.promise);
  game.modules.set('trigger-animations', { active: true }); game.modules.set('trigger-engine', { active: true });
  game.settings.get = () => true;
  class Base {
    constructor(options) { this.options = options; }
    getInputValue(key) { return key === 'mapping' ? 'enabled-trigger' : this.options; }
    executeNext() { return true; }
  }
  const Node = createTileArsenalNode(Base);
  globalThis.triggerAnimations = { api: { matchTrigger: () => ({ id: 'spell-arsenal-enabled-trigger' }),
    runFromTrigger: async ({ options }) => new Node(options)._execute() } };
  try {
    Hooks.callAll('createRegion', region);
    await flush();
    assert.equal(played.length, 1);
    earlier.resolve(); await runner.queue; await flush();
    assert.equal(played.length, 1);
  } finally { earlier.resolve(); game.settings.get = () => false; game.modules.delete('trigger-animations'); game.modules.delete('trigger-engine'); await runner.stop(false); }
});

test('area animation starts while earlier tile work still holds queue', async () => {
  const { runner, region } = await fixture('queued');
  const earlier = deferred();
  runner.submit(() => earlier.promise);
  try {
    Hooks.callAll('createRegion', region);
    await flush();
    assert.equal(played.length, 1, 'Animater waited behind tile writes');
  } finally { earlier.resolve(); await runner.stop(false); }
});

const animaterMain = new URL('../../animater/scripts/main.mjs', import.meta.url);
test('Toolbelt confirmation opens damage and plays real Animater Caustic Blast after source removal', { skip: !existsSync(animaterMain) }, async () => {
  const { resolveAutomaticRecipe, normalizeCatalogState } = await import('../../animater/scripts/spell-catalog.mjs');
  const { planRecipe } = await import('../../animater/scripts/model.mjs');
  const { templateArea } = await import('../../animater/scripts/canvas-preview-area.mjs');
  const source = readFileSync(animaterMain, 'utf8');
  const sourceForCode = source.slice(source.indexOf('function sourceFor(event)'), source.indexOf('function circleArea('));
  const sourceFor = new Function(`${sourceForCode}; return sourceFor;`)();
  const start = source.indexOf('async play(id, context = manualContext())');
  const playCode = source.slice(start, source.indexOf('    resolve:', start)).trim().replace(/,$/, '');
  const eventArea = context => templateArea(context.template, { source: context.source, spec: spell.system.area });
  const installedApi = new Function('findRecipe', 'sourceFor', 'eventArea', 'runtime', `return {${playCode}};`)(id => id, sourceFor, eventArea,
    { play(selected, context) {
      const assets = [...new Set(selected.stages.flatMap(stage => stage.assets))].map(key => ({ key }));
      const plan = planRecipe(selected, assets, { ...context, gridSize: 100 });
      assert.ok(plan.some(stage => stage.kind === 'projectile'));
      played.push({ recipe: selected, context });
    } });
  globalThis.CONFIG = { queries: {} };
  registerAreaAutomation();
  const { runner, region, target } = await fixture('real-recipe');
  const animationDone = deferred();
  let tileVisuals = 0;
  runner.createVisuals = async () => { tileVisuals++; return true; };
  runner.settings.REGION_HIGHLIGHT_ONLY_WHILE_EDITING = true;
  region.visibility = 0;
  region.update = async changes => { if ('visibility' in changes) region.visibility = changes.visibility; };
  region.isEffectArea = true; region.rendered = true;
  region.flags.pf2e.messageId = 'real-message';
  region.message.id = 'real-message';
  game.messages.set(region.message.id, region.message);
  game.modules.set('pf2e-toolbelt', { active: true });
  game.toolbelt = { getToolSetting: () => true };
  game.keyboard = { isModifierActive: () => false };
  spell.damageKinds = new Set(['damage']);
  let damageDialogs = 0;
  spell.rollDamage = async () => { damageDialogs++; assert.deepEqual([...game.user.targets], [target.object]); return {}; };
  const rule = { enabled: true, kind: 'area', spell: spell.name, areaMode: 'auto', instant: true };
  game.settings.get = (_id, key) => key === 'rules' ? [rule] : key === 'enabled' || key === 'autoRollDamage';
  canvas.tokens.setTargets = ids => { game.user.targets = new Set(ids.map(id => canvas.tokens.get(id))); };
  game.user.targets = new Set();
  region.delete = async () => { scene.regions.delete(region.id); Hooks.callAll('deleteRegion', region); };
  api.resolve = event => resolveAutomaticRecipe(event, normalizeCatalogState({ enabled: true, preferCatalog: true, sound: false }), []);
  api.play = async (...args) => { await installedApi.play(...args); await animationDone.promise; };
  try {
    const options = {};
    Hooks.callAll('preCreateRegion', region, {}, options, game.user.id);
    Hooks.callAll('createRegion', region, options, game.user.id);
    const placement = rollAreaPlacement(region);
    const helper = { options: Object.freeze({ classes: ['pf2e-toolbelt-template-helper'], window: { title: spell.name },
      buttons: { yes: { callback: async () => ({ targets: 'enemies', dismiss: true }) }, no: { callback: async () => ({ dismiss: false }) } } }) };
    Hooks.callAll('renderDialogV2', helper);
    await flush();
    assert.equal(damageDialogs, 0);
    assert.equal(played.length, 0, 'Animater played before targeting completed');
    await helper.options.buttons.yes.callback();
    canvas.tokens.setTargets([target.id]);
    // The native handler calls message.update and region.delete without awaiting
    // either. Exercise the server ordering that removes the source first.
    await region.delete();
    Hooks.callAll('preUpdateChatMessage', region.message, { flags: { 'pf2e-toolbelt': { targetHelper: { targets: [target.uuid] } } } });
    Hooks.callAll('closeDialogV2', helper);
    await placement; await flush();
    assert.equal(tileVisuals, 0, 'Spell Arsenal played during Animater playback');
    animationDone.resolve();
    await runner.animationTasks.get(region); await flush(); await runner.queue;
    assert.deepEqual(errors, [], 'real Animater recipe rejected Spell Arsenal context');
    assert.equal(damageDialogs, 1);
    assert.equal(played.length, 1);
    assert.deepEqual(played[0].context.targets, [target.object]);
    assert.equal(tileVisuals, 1, 'Toolbelt removal suppressed the second animation');
  } finally {
    animationDone.resolve();
    api.resolve = () => recipe; api.play = async (selected, context) => { played.push({ recipe: selected, context }); };
    game.modules.delete('pf2e-toolbelt'); game.settings.get = () => false;
    await runner.stop(false);
  }
});

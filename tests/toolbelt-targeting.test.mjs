import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as nodeModule from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
nodeModule.registerHooks?.({ load(url, context, nextLoad) {
  return nextLoad(url, url.includes('/spell-arsenal/scripts/') ? { ...context, format: 'module' } : context);
} });

const listeners = new Map();
globalThis.Hooks = {
  on(event, callback) { const list = listeners.get(event) ?? []; list.push(callback); listeners.set(event, list); },
  callAll(event, ...args) { for (const callback of listeners.get(event) ?? []) callback(...args); }
};
globalThis.CONFIG = { queries: {} };
const rules = [{ enabled: true, kind: 'area', spell: 'Caustic Blast', areaMode: 'manual', areaTriggers: ['placement'], instant: true }];
const settings = { enabled: true, rules, autoRollDamage: true };
let targets = [], rolls = [], targetWrites = [];
const gm = { id: 'gm', isGM: true, active: true };
const users = [gm]; users.activeGM = gm; users.contents = users; users.get = id => users.find(user => user.id === id);
globalThis.game = { user: gm, users, system: { id: 'pf2e' }, modules: new Map([['pf2e-toolbelt', { active: true }]]),
  toolbelt: { getToolSetting: () => true }, keyboard: { isModifierActive: () => false },
  settings: { get: (_module, key) => settings[key] }, messages: new Map() };
globalThis.ui = { notifications: { error: message => { throw new Error(message); }, warn() {} } };
globalThis.canvas = { tokens: { setTargets(ids) { targets = ids; targetWrites.push(ids); game.user.targets = new Set(canvas.scene.tokens.filter(token => ids.includes(token.id))); } } };
const actor = { id: 'caster', isOwner: true, isEnemyOf: other => other.id === 'enemy' };
const spell = { name: 'Caustic Blast', uuid: 'Actor.caster.Item.spell', type: 'spell', actor, damageKinds: new Set(['damage']),
  rollDamage: async () => { rolls.push([...targets]); return {}; } };
globalThis.fromUuidSync = uuid => uuid === spell.uuid ? spell : null;
const { registerAreaAutomation, rollAreaPlacement } = await import('../scripts/area-automation.js');
registerAreaAutomation();
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(id) {
  targets = []; rolls = []; targetWrites = [];
  gm.targets = new Set();
  const scene = { id: 'scene', regions: new Map(), tokens: [] };
  const enemy = { id: 'enemy', uuid: 'Scene.scene.Token.enemy', actor: { id: 'enemy' }, testInsideRegion: () => true, parent: scene };
  const ally = { id: 'ally', uuid: 'Scene.scene.Token.ally', actor: { id: 'ally' }, testInsideRegion: () => true, parent: scene };
  scene.tokens.push(enemy, ally);
  const message = { id: `message-${id}`, flags: {} }; game.messages.set(message.id, message);
  const region = { id, uuid: `Scene.scene.Region.${id}`, parent: scene, isEffectArea: true, shapes: [{}], rendered: true,
    flags: { pf2e: { messageId: message.id, origin: { uuid: spell.uuid, name: spell.name } } },
    delete: async () => { scene.regions.delete(id); Hooks.callAll('deleteRegion', region); } };
  scene.regions.set(id, region); canvas.scene = scene;
  globalThis.fromUuid = async uuid => uuid === region.uuid ? scene.regions.get(id) : scene.tokens.find(token => token.uuid === uuid);
  return { region, message, enemy, ally };
}
function dialog() {
  return { options: Object.freeze({ classes: ['pf2e-toolbelt-template-helper'], window: { title: spell.name },
    form: { closeOnSubmit: false },
    buttons: { yes: { callback: async (_event, button) => button.result }, no: { callback: async (_event, button) => button.result } },
    submit: async () => {} }) };
}
const coreDialogPath = 'C:/Program Files/Foundry Virtual Tabletop/resources/app/client/applications/api/dialog.mjs';
let coreSubmit;
if (existsSync(coreDialogPath)) {
  const source = readFileSync(coreDialogPath, 'utf8');
  const start = source.indexOf('async _onSubmit(target, event)');
  const method = source.slice(start, source.indexOf('\n  /*', start)).trim();
  coreSubmit = new Function(`return {${method}};`)()._onSubmit;
}
async function press(helper, result) {
  const action = Object.hasOwn(result, 'targets') ? 'yes' : 'no';
  if (coreSubmit) {
    helper.element = { querySelector: () => ({ disabled: false }) };
    return coreSubmit.call(helper, { dataset: { action }, result }, { preventDefault() {} });
  }
  const button = helper.options.buttons[action];
  const value = await button.callback({}, { result }, helper);
  await helper.options.submit(value, helper);
}
async function confirm(helper, message, selected) {
  await press(helper, { targets: 'all', dismiss: true });
  canvas.tokens.setTargets(selected.map(token => token.id));
  Hooks.callAll('updateChatMessage', message, { 'flags.pf2e-toolbelt.targetHelper.targets': selected.map(token => token.uuid) });
  Hooks.callAll('closeDialogV2', helper);
}
function start(region) {
  const options = {};
  Hooks.callAll('preCreateRegion', region, {}, options, game.user.id);
  Hooks.callAll('createRegion', region, options, game.user.id);
  return rollAreaPlacement(region);
}

test('damage waits for Toolbelt confirmation and keeps ally targets', async () => {
  const { region, message, ally } = fixture('delayed');
  const options = {};
  Hooks.callAll('preCreateRegion', region, {}, options, gm.id);
  Hooks.callAll('createRegion', region, options, gm.id);
  const task = rollAreaPlacement(region);
  await flush();
  assert.deepEqual(rolls, [], 'damage opened before Toolbelt finished targeting');
  const helper = dialog(); Hooks.callAll('renderDialogV2', helper);
  await confirm(helper, message, [ally]);
  await task;
  assert.deepEqual(rolls, [['ally']]);
  assert.deepEqual(targetWrites, [['ally']], 'Spell Arsenal overwrote Toolbelt targets');
});

test('Cancel and window close skip damage, even with old targets', async () => {
  for (const close of [false, true]) {
    const { region, enemy } = fixture(`cancel-${close}`);
    canvas.tokens.setTargets([enemy.id]);
    const task = start(region);
    await flush();
    const helper = dialog(); Hooks.callAll('renderDialogV2', helper);
    if (!close) await press(helper, { dismiss: false });
    Hooks.callAll('closeDialogV2', helper);
    await task;
    assert.deepEqual(rolls, []);
    assert.ok(region.parent.regions.has(region.id));
    await rollAreaPlacement(region);
    assert.deepEqual(rolls, []);
  }
});

test('confirmed zero targets never rolls against old targets', async () => {
  const { region, message, enemy } = fixture('empty');
  canvas.tokens.setTargets([enemy.id]);
  const task = start(region);
  await flush();
  const helper = dialog(); Hooks.callAll('renderDialogV2', helper);
  await confirm(helper, message, []);
  await task;
  assert.deepEqual(rolls, []);
});

test('Remove Template before card update still rolls once against chosen targets', async () => {
  const { region, message, enemy, ally } = fixture('removed');
  const task = start(region);
  const duplicate = rollAreaPlacement(region);
  await flush();
  const helper = dialog(); Hooks.callAll('renderDialogV2', helper);
  await press(helper, { targets: 'all', dismiss: true });
  canvas.tokens.setTargets([enemy.id, ally.id]);
  // Toolbelt does not await either message.update or region.delete. Deletion may arrive first.
  await region.delete();
  await flush();
  assert.deepEqual(rolls, []);
  Hooks.callAll('updateChatMessage', message, { flags: { 'pf2e-toolbelt': { targetHelper: { targets: [enemy.uuid, ally.uuid] } } } });
  Hooks.callAll('closeDialogV2', helper);
  await Promise.all([task, duplicate]);
  await rollAreaPlacement(region);
  assert.deepEqual(rolls, [['enemy', 'ally']]);
});

test('deletion during targeting and scene teardown cancel pending rolls', async () => {
  for (const teardown of [false, true]) {
    const { region } = fixture(`invalid-${teardown}`);
    const task = start(region);
    await flush();
    if (teardown) Hooks.callAll('canvasTearDown');
    else await region.delete();
    await task;
    assert.deepEqual(rolls, []);
  }
});

test('disabled damage preserves helper target choices', async () => {
  const { region, message, ally } = fixture('manual');
  settings.autoRollDamage = false;
  try {
    const task = start(region);
    await flush();
    const helper = dialog(); Hooks.callAll('renderDialogV2', helper);
    await confirm(helper, message, [ally]);
    await task;
    assert.deepEqual(rolls, []);
    assert.deepEqual(targetWrites, [['ally']]);
  } finally { settings.autoRollDamage = true; }
});

test('disabled Toolbelt, disabled helper, and Control bypass use ordinary targeting', async () => {
  for (const mode of ['module', 'helper', 'control']) {
    const { region } = fixture(`bypass-${mode}`);
    game.modules.get('pf2e-toolbelt').active = mode !== 'module';
    game.toolbelt.getToolSetting = () => mode !== 'helper';
    game.keyboard.isModifierActive = () => mode === 'control';
    try {
      await start(region);
      assert.deepEqual(rolls, [['enemy']]);
    } finally {
      game.modules.get('pf2e-toolbelt').active = true;
      game.toolbelt.getToolSetting = () => true;
      game.keyboard.isModifierActive = () => false;
    }
  }
});

test('owner roll query uses selected allies even when Toolbelt already removed region', async () => {
  const { region, message, ally } = fixture('owner');
  const options = {};
  Hooks.callAll('preCreateRegion', region, {}, options, gm.id);
  // Remember the region without scheduling a GM roll, as happens on the owner client.
  game.user = { id: 'player', isGM: false, active: true, targets: new Set() };
  try {
    Hooks.callAll('createRegion', region, options, gm.id);
    Hooks.callAll('updateChatMessage', message, { 'flags.pf2e-toolbelt.targetHelper.targets': [ally.uuid] });
    await region.delete();
    const result = await CONFIG.queries['spell-arsenal.area-cast']({ regionUuid: region.uuid, placement: true, event: 'placement', targetUuids: [ally.uuid] });
    assert.equal(result, true);
    assert.deepEqual(rolls, [['ally']]);
    // Non-GM clients never initiate their own placement roll.
    await rollAreaPlacement(region);
    assert.deepEqual(rolls, [['ally']]);
  } finally { game.user = gm; }
});

test('creator wait query reports confirmation and unrelated card updates cannot release it', async () => {
  const { region, message, ally } = fixture('query');
  const task = start(region);
  let response;
  const query = Promise.resolve(CONFIG.queries['spell-arsenal.area-targets']({ regionUuid: region.uuid })).then(result => { response = result; });
  const helper = dialog(); Hooks.callAll('renderDialogV2', helper);
  await confirm(helper, { id: 'other-message' }, [ally]);
  await flush();
  assert.equal(response, undefined);
  assert.deepEqual(rolls, []);
  Hooks.callAll('updateChatMessage', message, { 'flags.pf2e-toolbelt.targetHelper.targets': [ally.uuid] });
  await Promise.all([task, query]);
  assert.deepEqual(response, { handled: true, targets: [ally.uuid] });
  assert.deepEqual(rolls, [['ally']]);
});

test('no-op card update still releases targeting before deletion', async () => {
  const { region, message, ally } = fixture('unchanged');
  canvas.tokens.setTargets([ally.id]);
  const task = start(region);
  const helper = dialog(); Hooks.callAll('renderDialogV2', helper);
  await press(helper, { targets: 'all', dismiss: false });
  Hooks.callAll('preUpdateChatMessage', message, { 'flags.pf2e-toolbelt.targetHelper.targets': [ally.uuid] });
  await task;
  assert.deepEqual(rolls, [['ally']]);
});

test('background update of the same card cannot bypass an open Target dialog', async () => {
  const { region, message, ally } = fixture('background');
  const task = start(region);
  const helper = dialog(); Hooks.callAll('renderDialogV2', helper);
  Hooks.callAll('preUpdateChatMessage', message, { 'flags.pf2e-toolbelt.targetHelper.targets': [ally.uuid] });
  await flush();
  assert.deepEqual(rolls, []);
  await confirm(helper, message, [ally]);
  await task;
  assert.deepEqual(rolls, [['ally']]);
});

test('GM waits for player creator despite different local helper settings', async () => {
  const { region, ally } = fixture('remote');
  let resolveTargets;
  const player = { id: 'creator-player', active: true, isGM: false, query: async (name, data) => {
    assert.equal(name, 'spell-arsenal.area-targets');
    assert.equal(data.regionUuid, region.uuid);
    return new Promise(resolve => { resolveTargets = resolve; });
  } };
  users.push(player);
  game.toolbelt.getToolSetting = () => false;
  try {
    Hooks.callAll('createRegion', region, { spellArsenalTargetHelper: player.id }, player.id);
    const task = rollAreaPlacement(region);
    await flush();
    assert.deepEqual(rolls, []);
    await region.delete();
    resolveTargets({ handled: true, targets: [ally.uuid] });
    await task;
    assert.deepEqual(rolls, [['ally']]);
  } finally { users.pop(); game.toolbelt.getToolSetting = () => true; }
});

test('helper without a spell card completes on confirmed dialog close', async () => {
  const { region, ally } = fixture('no-card');
  delete region.flags.pf2e.messageId;
  const task = start(region);
  const helper = dialog(); Hooks.callAll('renderDialogV2', helper);
  await press(helper, { targets: 'all', dismiss: true });
  canvas.tokens.setTargets([ally.id]);
  await region.delete();
  Hooks.callAll('closeDialogV2', helper);
  await task;
  assert.deepEqual(rolls, [['ally']]);
});

const toolbeltMap = new URL('../../pf2e-toolbelt/scripts/main.js.map', import.meta.url);
test('installed Toolbelt handler completes targeting before Spell Arsenal damage', { skip: !existsSync(toolbeltMap) }, async () => {
  const map = JSON.parse(readFileSync(toolbeltMap, 'utf8'));
  const source = map.sourcesContent[map.sources.findIndex(path => path.endsWith('target-helper/tool/tool.ts'))];
  // Execute the installed handler, removing only TypeScript annotations.
  const body = source.slice(source.indexOf('async #onCreateRegion('), source.indexOf('    #onPreCreateChatMessage('))
    .replace(/^async #onCreateRegion\([^\n]+\) \{/, '')
    .replace(/\}\s*$/, '')
    .replace(' as (ItemOriginFlag & { name: string }) | undefined', '')
    .replace('fromUuid<ActorPF2e>', 'fromUuid')
    .replace(/waitDialog<TemplateDialogData \| Pick<TemplateDialogData, "dismiss">>/, 'waitDialog')
    .replace('htmlQuery<HTMLInputElement>', 'htmlQuery');
  const createHandler = new Function('waitDialog', 'SYSTEM', 'MODULE', 'isHoldingModifierKey', 'getFirstActiveToken', 'oppositeAlliance', 'lineIntersect', 'htmlQuery',
    `return async function(region, _context, userId) {${body}}`);
  const { region, message, enemy, ally } = fixture('installed');
  region.tokens = [enemy, ally];
  region.shapes = [{ x: 0, y: 0 }];
  for (const token of region.tokens) {
    token.actor.alliance = token === enemy ? 'opposition' : 'party';
    token.actor.isOfType = () => true;
    token.object = { center: { x: 1, y: 1 } };
  }
  globalThis.foundry = { data: { PolygonShapeData: class {}, EmanationShapeData: class {} } };
  message.update = async changes => {
    Hooks.callAll('preUpdateChatMessage', message, changes);
    await flush();
    Hooks.callAll('updateChatMessage', message, changes);
  };
  let helper;
  const handler = createHandler(async options => new Promise(resolve => {
    helper = { options: Object.freeze({ ...options, window: { title: options.title }, form: { closeOnSubmit: false },
      buttons: { yes: { callback: async (_event, button) => button.result }, no: { callback: async (_event, button) => button.result } },
      submit: async result => resolve(result) }) };
    Hooks.callAll('renderDialogV2', helper);
  }), { id: 'pf2e' }, { isDebug: false }, () => false, () => null, alliance => alliance === 'party' ? 'opposition' : 'party', () => false, () => null);
  const task = start(region);
  const toolbelt = handler.call({ settings: { dismissTemplate: true }, getFlag: () => false, templatePath: () => '', path: () => '',
    setMessageFlagTargets: (_updates, uuids) => ({ 'flags.pf2e-toolbelt.targetHelper.targets': uuids }) }, region, {}, gm.id);
  await flush();
  assert.deepEqual(rolls, []);
  await press(helper, { targets: 'all', self: true, neutral: true, dismiss: true });
  await Promise.all([toolbelt, task]);
  assert.deepEqual(rolls, [['enemy', 'ally']]);
});

import { systemAdapter } from './systems.js';
import { tokenInsideArea, crossesArea } from './area-movement.js';
import { isInstant } from './rules.js';
import { AREA_TRIGGERS, areaTriggers, areaRepeatKey } from './area-triggers.js';
const seen = new Set();
let promptQueue = Promise.resolve();
const dialogs = new Set();
let castQueue = Promise.resolve();
const placements = new Set();
let eventSequence = 0;
function playerOwner(actor) {
  const users = game.users.contents ?? (game.users[Symbol.iterator] ? [...game.users] : []);
  const owners = users.filter(user => user.active && !user.isGM && actor?.testUserPermission?.(user, 'OWNER'));
  return owners.find(user => user.character?.id === actor.id) ?? owners[0];
}
export async function requestCasterRoll(spell, region, token, event, valid, placement = false) {
  if (!valid()) return false;
  const owner = playerOwner(spell.actor);
  if (owner?.query) {
    try { return await owner.query('spell-arsenal.area-cast', { regionUuid: region.uuid, tokenUuid: token?.uuid, event, placement }, { timeout: 120000 }); }
    catch (error) { console.warn('Spell Arsenal caster request', error); if (valid()) ui.notifications.warn(`Roll request to ${owner.name} ended without a response. Use the spell card if needed.`); return false; }
  }
  if (placement) return systemAdapter(spell).areaCastActions(spell, region)[0]?.run();
  if (token.id) globalThis.canvas?.tokens?.setTargets?.([token.id], { mode: 'replace' });
  return showAreaPrompt(spell, token, event, { valid, damageOnly: true });
}
const escape = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const promptLabel = label => label.replace(/\b(str|dex|con|int|wis|cha)\b/g, ability => ({ str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' }[ability])).replace(/\(DC (\d+)\)/g, '- DC $1');
export function showAreaPrompt(spell, token, event, { valid = () => true, savesOnly = false, damageOnly = false } = {}) {
  const task = promptQueue.then(async () => {
    if (!valid()) return 'cancelled';
    const actions = systemAdapter(spell).areaActions(spell, token, event).filter(action => (!savesOnly || action.id.startsWith('save')) && (!damageOnly || action.id.startsWith('damage')));
    if ((savesOnly || damageOnly) && !actions.length) return 'skip';
    const showDC = systemAdapter(spell).areaShowDC(spell);
    const saveCount = actions.filter(action => action.id.startsWith('save')).length;
    const buttons = actions.map(action => {
      const label = action.id.startsWith('save') && saveCount === 1 ? action.label.replace(/^.*?:\s*/, '') : action.label;
      return { action: action.id, label: promptLabel(showDC ? label : label.replace(/\s*\(DC \d+\)/g, '')), icon: action.id.startsWith('save') ? 'fa-solid fa-shield-halved' : 'fa-solid fa-dice', callback: async () => {
      if (!valid()) return 'cancelled';
      const result = await action.run();
      return result ? action.id : 'cancelled';
    } }; });
    const save = actions.find(action => action.id.startsWith('save')), damage = actions.find(action => action.id.startsWith('damage'));
    if (save && damage && actions.filter(a => a.id.startsWith('save')).length === 1 && actions.filter(a => a.id.startsWith('damage')).length === 1) buttons.push({ action: 'both', label: 'Roll save and damage', callback: async () => {
      if (!valid()) return 'cancelled';
      const result = await save.run();
      if (result && valid()) await damage.run();
      return result ? 'both' : 'cancelled';
    } });
    buttons.push({ action: 'skip', label: 'Skip this trigger', icon: 'fa-solid fa-forward', default: true });
    let active;
    const timer = setInterval(() => { if (active && !valid()) void active.dialog.close(); }, 500);
    const image = token.texture?.src ?? token.actor?.img ?? spell.img;
    try { return await foundry.applications.api.DialogV2.wait({ classes: ['spell-arsenal-area-prompt'], position: { width: 440 }, window: { title: `${spell.name} - ${token.name || token.actor.name}`, resizable: true },
      content: `<div class="area-prompt-summary">${image ? `<img src="${escape(image)}" alt="">` : '<i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>'}<div><strong>${escape(spell.name)}</strong><p><strong>${escape(token.name || token.actor.name)}</strong> ${{ turn: 'starts its turn in', 'turn-end': 'ends its turn in', placement: 'is covered by', entry: 'entered', exit: 'left' }[event] ?? 'entered'} this area.</p></div></div><p class="area-prompt-hint">${actions.length ? (actions.every(action => action.id.startsWith('save')) ? 'Choose the save for this trigger.' : 'Choose a roll. Apply damage from its chat result.') : 'Roll details unavailable. Use the original spell card in chat.'}</p>`,
      buttons, rejectClose: false, render: (_event, dialog) => { active = { dialog, valid }; dialogs.add(active); if (!valid()) void dialog.close(); } });
    } finally { clearInterval(timer); if (active) dialogs.delete(active); }
  });
  promptQueue = task.catch(() => {});
  return task;
}
export async function requestAreaSave(spell, region, token, event, valid, savesOnly = false) {
  if (!valid()) return 'cancelled';
  if (savesOnly && systemAdapter(spell).handlesAreaSaves()) return 'skip';
  const actions = systemAdapter(spell).areaActions(spell, token, event);
  if (!actions.length && !savesOnly) return showAreaPrompt(spell, token, event, { valid });
  const hasSave = actions.some(action => action.id.startsWith('save'));
  const owner = playerOwner(token.actor);
  if (hasSave && !owner?.query) await showAreaPrompt(spell, token, event, { valid, savesOnly: true });
  else if (hasSave) try {
    await owner.query('spell-arsenal.area-save', { regionUuid: region.uuid, tokenUuid: token.uuid, event }, { timeout: 120000 });
  } catch (error) {
    console.warn('Spell Arsenal owner save request', error);
    if (valid()) ui.notifications.warn(`Save request to ${owner.name} ended without a response. Use the spell card if a save is still needed.`);
  }
  return savesOnly ? 'skip' : requestCasterRoll(spell, region, token, event, valid);
}
const inside = tokenInsideArea;
export function areaAutomation(region) {
  if (!game.settings.get('spell-arsenal', 'enabled') || region.flags?.world?.spellArsenalArea) return null;
  const adapter = systemAdapter(), spell = adapter.regionCastSpell(region);
  if (!spell || adapter.placementPending(region) || adapter.handlesAreaAutomation(spell)) return null;
  const rule = game.settings.get('spell-arsenal', 'rules').find(r => r.enabled && r.kind === 'area' && areaTriggers(r, spell).length && r.spell.trim().toLowerCase() === spell.name.trim().toLowerCase());
  if (rule && !isInstant(rule) && rule.duration > 0 && region._stats?.createdTime && Date.now() >= region._stats.createdTime + rule.duration * 1000) return null;
  return rule ? { rule, spell } : null;
}
export async function promptArea(region, token, event, crossed = false, savesOnly = false, clock = game.combat) {
  if (!game.user.isGM || game.users.activeGM?.id !== game.user.id || !token.actor || (event !== 'exit' && !crossed && !inside(region, token))) return;
  const match = areaAutomation(region);
  if (!match || !areaTriggers(match.rule, match.spell).includes(event)) return;
  const period = areaRepeatKey(match.rule, region, token, clock, match.spell);
  const key = `${region.uuid}:${token.uuid}:${period ?? (event === 'placement' ? 'placement' : ++eventSequence)}`;
  if (seen.has(key)) return;
  seen.add(key); if (seen.size > 1000) seen.delete(seen.values().next().value);
  try {
    const valid = () => game.user.isGM && game.users.activeGM?.id === game.user.id && Boolean(areaAutomation(region)) &&
      (!region.parent?.regions?.has || region.parent.regions.has(region.id)) && (!token.parent?.tokens?.has || token.parent.tokens.has(token.id));
    await requestAreaSave(match.spell, region, token, event, valid, savesOnly);
  } catch (error) { seen.delete(key); console.error('Spell Arsenal area automation', error); ui.notifications.error(error.message); }
}
export function areaEnemyTokens(region, spell) {
  const tokens = [...region.parent.tokens];
  const caster = spell.actor?.token ?? tokens.find(token => token.actor?.id === spell.actor?.id);
  return tokens.filter(token => token.actor && token.actor.id !== spell.actor?.id && systemAdapter(spell).areaEnemy(spell, caster, token) && inside(region, token));
}
export function rollAreaPlacement(region) {
  const task = castQueue.then(async () => {
    if (!game.user.isGM || game.users.activeGM?.id !== game.user.id || placements.has(region.uuid)) return;
    const match = areaAutomation(region);
    if (!match || !areaTriggers(match.rule, match.spell).includes('placement')) return;
    if (systemAdapter(match.spell).areaCastActions(match.spell, region)[0]?.id === 'damage' && game.settings.get('spell-arsenal', 'autoRollDamage') === false) {
      canvas.tokens.setTargets(areaEnemyTokens(region, match.spell).map(token => token.id), { mode: 'replace' });
      return;
    }
    let tokens = areaEnemyTokens(region, match.spell);
    for (let attempt = 0; !tokens.length && attempt < 5; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      tokens = areaEnemyTokens(region, match.spell);
    }
    placements.add(region.uuid);
    const valid = () => game.user.isGM && game.users.activeGM?.id === game.user.id && Boolean(areaAutomation(region)) && (!region.parent.regions.has || region.parent.regions.has(region.id)) && (!globalThis.canvas?.scene || canvas.scene.id === region.parent.id);
    if (!valid()) return;
    try {
      canvas.tokens.setTargets(tokens.map(token => token.id), { mode: 'replace' });
      if (!valid()) return;
      const actions = systemAdapter(match.spell).areaCastActions(match.spell, region);
      if (actions.length) {
        const result = await requestCasterRoll(match.spell, region, tokens[0], 'placement', valid, true);
        if (!result || (Array.isArray(result) && !result.length)) return;
        for (const token of tokens) if (valid()) await promptArea(region, token, 'placement', false, true);
        if (actions[0].id === 'damage' && isInstant(match.rule) && valid()) await region.delete();
      } else for (const token of tokens) await promptArea(region, token, 'placement');
    } catch (error) { console.error('Spell Arsenal area roll', error); ui.notifications.error(error.message); }
  });
  castQueue = task.catch(() => {});
  return task;
}
export async function cleanupInstantDamage(message) {
  if (!game.user.isGM || game.users.activeGM?.id !== game.user.id || !game.settings.get('spell-arsenal', 'enabled')) return;
  const adapter = systemAdapter(), spell = adapter.areaDamageSpell(message);
  if (spell?.type !== 'spell' || !spell.uuid || !message.rolls?.length) return;
  const rule = game.settings.get('spell-arsenal', 'rules').find(rule => rule.enabled && rule.kind === 'area' && isInstant(rule) && rule.spell.trim().toLowerCase() === spell.name.trim().toLowerCase());
  if (!rule) return;
  const scene = game.scenes?.get(message.speaker?.scene) ?? globalThis.canvas?.scene;
  if (!scene) return;
  const matches = [...scene.regions].filter(region => !region.flags?.world?.spellArsenalArea && adapter.regionCastSpell(region)?.uuid === spell.uuid && !adapter.placementPending(region));
  // A damage message without a cast link cannot distinguish multiple templates of the same spell.
  if (matches.length !== 1 || placements.has(matches[0].uuid)) return;
  await matches[0].delete();
}
export function registerAreaAutomation() {
  CONFIG.queries['spell-arsenal.area-cast'] = async data => {
    if (!Object.hasOwn(AREA_TRIGGERS, data.event)) return false;
    const region = await fromUuid(data.regionUuid);
    const match = region && areaAutomation(region);
    if (!match?.spell.actor?.isOwner || (globalThis.canvas?.scene && canvas.scene.id !== region.parent.id)) return false;
    const valid = () => match.spell.actor.isOwner && Boolean(areaAutomation(region)) && region.parent.regions.has(region.id);
    if (data.placement) {
      if (!valid()) return false;
      if (systemAdapter(match.spell).areaCastActions(match.spell, region)[0]?.id === 'damage' && game.settings.get('spell-arsenal', 'autoRollDamage') === false) return false;
      canvas.tokens.setTargets(areaEnemyTokens(region, match.spell).map(token => token.id), { mode: 'replace' });
      const result = await systemAdapter(match.spell).areaCastActions(match.spell, region)[0]?.run();
      return Boolean(result && (!Array.isArray(result) || result.length));
    }
    const token = await fromUuid(data.tokenUuid);
    if (!token || token.parent !== region.parent) return false;
    if (!valid()) return false;
    canvas.tokens.setTargets([token.id], { mode: 'replace' });
    return showAreaPrompt(match.spell, token, data.event, { valid, damageOnly: true });
  };
  Hooks.on('createChatMessage', message => { void cleanupInstantDamage(message).catch(error => { console.error('Spell Arsenal instant template cleanup', error); ui.notifications.error(error.message); }); });
  CONFIG.queries['spell-arsenal.area-save'] = async data => {
    const region = await fromUuid(data.regionUuid), token = await fromUuid(data.tokenUuid);
    if (!Object.hasOwn(AREA_TRIGGERS, data.event) || !region || !token || token.parent !== region.parent || !token.actor?.isOwner || !areaAutomation(region)) return 'cancelled';
    const spell = systemAdapter().regionCastSpell(region);
    return showAreaPrompt(spell, token, data.event, { savesOnly: true, valid: () => token.actor.isOwner && token.parent.tokens.has(token.id) && region.parent.regions.has(region.id) && Boolean(areaAutomation(region)) });
  };
  const placement = region => { void rollAreaPlacement(region); };
  Hooks.on('createRegion', placement);
  Hooks.on('updateRegion', (region, changes) => { if ('shapes' in changes || systemAdapter().regionFlagsChanged(changes)) placement(region); });
  Hooks.on('preUpdateToken', (token, changes, options) => {
    if (['x', 'y', 'elevation', 'level'].some(k => k in changes)) {
      const regions = [...token.parent.regions].filter(r => areaAutomation(r));
      options.spellArsenalInside = regions.filter(r => inside(r, token)).map(r => r.id);
      options.spellArsenalCrossed = regions.filter(r => !inside(r, token) && crossesArea(r, token, changes, options)).map(r => r.id);
    }
  });
  Hooks.on('updateToken', (token, changes, options) => {
    if (Array.isArray(options.spellArsenalInside)) for (const region of token.parent.regions) {
      const wasInside = options.spellArsenalInside.includes(region.id), crossed = options.spellArsenalCrossed?.includes(region.id);
      if (!wasInside) void promptArea(region, token, 'entry', crossed);
      if ((wasInside || crossed) && !inside(region, token)) void promptArea(region, token, 'exit');
    }
  });
  Hooks.on('preUpdateCombat', (combat, changes, options) => {
    if ('turn' in changes || 'round' in changes) options.spellArsenalPreviousTurn = { tokenUuid: combat.combatant?.token?.uuid, id: combat.id, started: combat.started, round: combat.round, turn: combat.turn, turns: combat.turns.map(c => ({ tokenId: c.tokenId })) };
  });
  Hooks.on('updateCombat', (combat, changes, options = {}) => {
    const previous = options.spellArsenalPreviousTurn;
    const oldToken = previous?.tokenUuid && fromUuidSync(previous.tokenUuid);
    if (previous?.started && oldToken) for (const region of oldToken.parent.regions) void promptArea(region, oldToken, 'turn-end', false, false, previous);
    const token = combat.combatant?.token;
    if (combat.started && token && ('turn' in changes || 'round' in changes)) for (const region of token.parent.regions) void promptArea(region, token, 'turn');
  });
  Hooks.on('deleteRegion', region => { placements.delete(region.uuid); for (const key of seen) if (key.startsWith(`${region.uuid}:`)) seen.delete(key); });
  const closeInvalid = () => { for (const { dialog, valid } of dialogs) if (!valid()) void dialog.close(); };
  for (const hook of ['deleteRegion', 'deleteToken', 'deleteActor', 'updateSetting', 'updateUser', 'canvasTearDown']) Hooks.on(hook, closeInvalid);
}

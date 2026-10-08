import { stageRecords, chooseStage, spellStageRank, replaceOverlaps } from './stages.js';
import { spellAreaInfo } from './spell-parser.js';
import { systemAdapter } from './systems.js';
import { regionCoverage } from './region-coverage.js';
import { dispatchTileVisual } from './trigger-integration.js';
import { playAnimater, recordAnimation } from './animater-integration.js';
import { waitForToolbeltTargets } from './toolbelt-targeting.js';
import { areaEnemyTokens } from './area-automation.js';

const documentTypes = ['Tile', 'AmbientLight', 'AmbientSound', 'Region'];
const ownershipFlags = { area: 'spellArsenalArea', damage: 'spellArsenalDamage', caster: 'spellArsenalCaster' };
const authorized = () => game.user.isGM && game.users.activeGM?.id === game.user.id;
const normalized = value => String(value ?? '').trim().toLowerCase();
let pendingWork = Promise.resolve();

export async function runSpellEffect(kind, settings, owner) {
  if (!authorized()) return;
  if (!game.modules.get('tile-arsenal')?.active || !globalThis.tileArsenal) throw new Error('Enable Tile Arsenal first.');
  const library = await tileArsenal.utils.getConfigurations();
  const preset = Object.values(library.configurations).find(entry => normalized(entry.name) === normalized(settings.EFFECT_NAME));
  if (!preset?.toDocumentData) throw new Error(`Tile Arsenal effect "${settings.EFFECT_NAME}" is unavailable.`);
  const stages = [...new Set(Object.values(preset.configs ?? {}).map(entry => entry.stage))].sort((a, b) => a - b);
  if (!stages.length || (settings.STAGE_MODE === 'fixed' && !stages.includes(settings.STAGE))) throw new Error('Select an available Tile Arsenal stage.');
  const parts = Object.values(preset.configs ?? {}).filter(part => settings.STAGE_MODE !== 'fixed' || part.stage === settings.STAGE);
  if (parts.some(part => !documentTypes.includes(part.type) || (kind !== 'area' && part.type === 'Region')))
    throw new Error('This Tile Arsenal effect contains unsupported document types for the selected trigger.');
  const runner = new SpellVisualRunner(kind, settings, owner, preset, stages);
  try { await runner.start(); }
  catch (error) { await runner.stop(); throw error; }
  return runner;
}

class SpellVisualRunner {
  constructor(kind, settings, owner, preset, stages) {
    Object.assign(this, { kind, settings, owner, preset, stages });
    this.flag = ownershipFlags[kind];
    this.adapter = systemAdapter();
    this.enabled = true;
    this.hooks = [];
    this.timers = new Map();
    this.received = new Set();
    this.animated = new Map();
    this.animationTasks = new WeakMap();
    this.confirmedAnimationRegions = new WeakSet();
    this.finished = new Set();
    this.deadlines = new Map();
    this.queue = Promise.resolve();
  }

  report(error) {
    console.error('Spell Arsenal', error);
    ui.notifications.error(`${this.settings.SPELL_NAME}: ${error.message}`);
  }

  listen(event, handler) { this.hooks.push([event, Hooks.on(event, handler)]); }

  submit(job, propagate = false) {
    const task = pendingWork.then(() => this.enabled && authorized() ? job() : undefined);
    pendingWork = task.catch(error => { if (!propagate) this.report(error); });
    this.queue = pendingWork;
    return propagate ? task : pendingWork;
  }

  owned(scene, source) {
    return documentTypes.flatMap(type => [...scene.getEmbeddedCollection(type)].flatMap(document => {
      const data = document.flags?.world?.[this.flag];
      return data?.owner === this.owner && (!source || data.source === source || data.regionId === source || data.messageId === source)
        ? [{ type, document, data }] : [];
    }));
  }

  async erase(scene, source) {
    if (!authorized()) return;
    const entries = this.owned(scene, source);
    for (const type of documentTypes) {
      const ids = entries.filter(entry => entry.type === type).map(entry => entry.document.id);
      if (ids.length) await scene.deleteEmbeddedDocuments(type, ids);
    }
  }

  matches(region) {
    if (region.flags?.world?.[this.flag]) return false;
    return normalized(this.adapter.regionName(region)) === normalized(this.settings.SPELL_NAME);
  }

  visible(region) {
    return canvas.ready && region.parent === canvas.scene && canvas.level && (!region.levels?.size || region.levels.has(canvas.level.id));
  }

  lifetime(region) {
    return this.adapter.lifetime(region, this.settings);
  }

  async start() {
    this.listen('createChatMessage', message => this.handleMessage(message));
    if (this.kind === 'damage') this.adapter.listenDamage(this.listen.bind(this), (message, token) => {
      if (normalized(message.item?.name) !== normalized(this.settings.SPELL_NAME)) return;
      const position = { center: token.getCenterPoint(), elevation: token.elevation, levelId: token.level };
      this.submit(() => this.renderToken(message, token, position));
    });
    if (this.kind === 'damage') this.listen('updateChatMessage', message => {
      if (this.adapter.reverted(message))
        this.submit(async () => { for (const scene of game.scenes) await this.erase(scene, message.id); });
    });
    if (this.kind === 'area') {
      this.listen('createRegion', region => { if (this.matches(region)) this.queueRegion(region); });
      this.listen('updateRegion', (region, changes) => {
        if (this.matches(region) && (['shapes', 'elevation', 'levels', 'hidden', 'restriction', '_shapeConstraints'].some(key => key in changes) || this.adapter.regionFlagsChanged(changes)))
          this.queueRegion(region);
      });
      this.listen('deleteRegion', region => {
        if (region.flags?.world?.[this.flag]) return;
        this.submit(async () => {
          clearTimeout(this.timers.get(region.id)); this.timers.delete(region.id);
          this.deadlines.delete(region.id); this.finished.delete(region.uuid);
          await this.erase(region.parent, region.id);
        });
      });
      this.listen('canvasReady', () => this.submit(() => this.recover()));
    }
    await this.submit(async () => {
      for (const scene of game.scenes) {
        if (this.kind !== 'area') await this.erase(scene);
        else {
          const sources = new Map(this.owned(scene).map(entry => [entry.data.regionId, entry]));
          for (const [source, entry] of sources) {
            const region = scene.regions.get(source);
            if (!region || !this.matches(region)) { await this.erase(scene, source); continue; }
            if (entry.data.expiresAt && this.lifetime(region) > 0) this.armExpiry(scene, source, entry.data.expiresAt);
          }
          for (const region of scene.regions) {
            if (region.flags?.world?.spellArsenalPlacement?.owner === this.owner) await region.delete();
            else if (this.matches(region) && this.lifetime(region) > 0 && !this.owned(scene, region.id).length) {
              this.finished.add(region.uuid);
              await this.restoreOverlay(region);
            }
          }
        }
      }
      if (this.kind === 'area') await this.recover();
    }, true);
  }

  async recover() {
    for (const region of canvas.scene?.regions ?? []) if (this.matches(region)) {
      const existing = this.owned(region.parent, region.id);
      if (this.lifetime(region) > 0 && !existing.length && !this.deadlines.has(region.id)) { this.finished.add(region.uuid); continue; }
      await this.renderRegion(region);
    }
  }

  handleMessage(message) {
    if (!this.enabled || !authorized()) return;
    message = this.adapter.messageEvent(message, this.kind);
    if (!message) return;
    const spell = message.item;
    if (!(spell?.type === 'spell' || spell?.isOfType?.('spell')) || normalized(spell.name) !== normalized(this.settings.SPELL_NAME)) return;
    if (this.received.has(message.id)) return;
    this.received.add(message.id);
    if (this.received.size > 500) this.received.delete(this.received.values().next().value);
    if (this.kind === 'area') {
      if (spellAreaInfo(spell).hasTemplate || this.adapter.handlesPlacement(spell) || this.pickerTask) return;
      this.pickerTask = this.pickCells(message).catch(error => this.report(error)).finally(() => { this.pickerTask = null; });
      return;
    }
    const candidates = (canvas.tokens?.placeables ?? []).filter(token => token.actor?.id === message.actor?.id && token.document.level === canvas.level?.id);
    const token = message.token ?? (this.kind === 'caster' && candidates.length === 1 ? candidates[0].document : null);
    if (!token) return;
    const snapshot = { center: token.getCenterPoint(), elevation: token.elevation, levelId: token.level };
    this.submit(() => this.renderToken(message, token, snapshot));
  }

  async createVisuals(scene, source, cells, decorate, duration, rank = 1) {
    const batches = new Map();
    const previous = [];
    const existing = this.owned(scene, source);
    const deadline = duration > 0 ? this.deadlines.get(source) ?? existing.find(entry => entry.data.expiresAt)?.data.expiresAt ?? Date.now() + duration * 1000 : 0;
    if (deadline && deadline <= Date.now()) { await this.erase(scene, source); return false; }
    for (const offset of cells) {
      const cell = `${offset.i}:${offset.j}`;
      const records = stageRecords(scene, normalized(this.settings.EFFECT_NAME), canvas.level.id, cell);
      const stage = chooseStage(records, source, this.stages, this.settings.STAGE_MODE ?? 'auto', this.settings.STAGE, rank);
      previous.push(...records);
      for (const [type, rows] of this.preset.toDocumentData(offset, stage)) {
        if (!documentTypes.includes(type) || (this.kind !== 'area' && type === 'Region')) throw new Error(`Unsupported visual document: ${type}`);
        if (!batches.has(type)) batches.set(type, []);
        for (const row of rows) {
          const data = foundry.utils.expandObject(foundry.utils.deepClone(row));
          delete data._id;
          if (type === 'Region') data.behaviors = [];
          if (data.flags) delete data.flags['tile-arsenal'];
          data.flags ??= {};
          data.flags.world ??= {};
          data.flags.world[this.flag] = { owner: this.owner, source, offset: cell, effect: normalized(this.settings.EFFECT_NAME), levelId: canvas.level.id, stage, expiresAt: deadline,
            ...(this.kind === 'area' ? { regionId: source } : { messageId: source }) };
          data.name = `${this.settings.SPELL_NAME}: ${this.settings.EFFECT_NAME}`;
          data.levels = [canvas.level.id];
          decorate(data, type, offset);
          batches.get(type).push(data);
        }
      }
    }
    await this.erase(scene, source);
    try {
      for (const [type, rows] of batches) {
        if (!this.enabled || !authorized()) return false;
        if (rows.length) await scene.createEmbeddedDocuments(type, rows);
      }
      if (!this.enabled || !authorized()) return false;
      if (this.settings.STAGE_MODE !== 'fixed') await replaceOverlaps(scene, previous, source);
    } catch (error) { await this.erase(scene, source); throw error; }
    if (deadline) this.armExpiry(scene, source, deadline);
    return true;
  }

  armExpiry(scene, source, deadline) {
    this.deadlines.set(source, deadline);
    clearTimeout(this.timers.get(source));
    this.timers.set(source, setTimeout(() => {
      this.timers.delete(source);
      this.submit(async () => {
        const region = scene.regions.get?.(source);
        if (region) this.finished.add(region.uuid);
        await this.erase(scene, source);
        if (region) await this.restoreOverlay(region);
        this.deadlines.delete(source);
      });
    }, Math.max(0, deadline - Date.now())));
  }

  async renderToken(message, token, position, dispatched = false) {
    if (!dispatched) return dispatchTileVisual({ id: this.owner.replace(/^spell-arsenal:/, ''), spell: this.settings.SPELL_NAME, kind: this.kind }, () => this.renderToken(message, token, position, true));
    if (this.adapter.reverted(message)) return;
    if (!canvas.ready || canvas.scene !== token.parent || canvas.level?.id !== position.levelId) return;
    if (canvas.grid.isGridless) throw new Error('Spell visuals require a grid.');
    const offset = canvas.grid.getOffset(position.center);
    const center = canvas.grid.getCenterPoint(offset);
    if (this.settings.ANIMATER) await this.animate(message.id, { type: this.kind === 'damage' ? 'damage' : 'use', item: message.item, actor: message.actor,
      tokenId: this.kind === 'caster' ? token.id : message.speaker?.token, sceneId: token.parent.id }, { targets: this.kind === 'damage' && token.object ? [token.object] : [] });
    if (!this.enabled || !authorized() || this.adapter.reverted(message) || !canvas.ready || canvas.scene !== token.parent || canvas.level?.id !== position.levelId) return;
    await this.createVisuals(token.parent, message.id, [offset], (data, type) => {
      data.x = Math.round(data.x + position.center.x - center.x);
      data.y = Math.round(data.y + position.center.y - center.y);
      data.elevation = this.kind === 'caster' ? data.elevation + position.elevation - canvas.level.elevation.base
        : position.elevation + (type === 'Tile' ? this.settings.TILE_ELEVATION_OFFSET ?? 0.1 : 0);
    }, this.settings.DURATION_SECONDS, spellStageRank(message.item, this.adapter.messageOrigin(message)));
    if (!this.enabled || this.adapter.reverted(message)) return this.erase(token.parent, message.id);
  }

  animate(source, event, context) {
    if (this.animated.has(source)) return this.animated.get(source);
    const task = playAnimater(event, context).catch(error => this.report(error));
    this.animated.set(source, task);
    if (this.animated.size > 500) this.animated.delete(this.animated.keys().next().value);
    return task;
  }

  queueRegion(region) {
    recordAnimation(this.settings.SPELL_NAME, 'Placed', `Animater ${this.settings.ANIMATER ? 'enabled' : 'disabled'}`, region.uuid);
    if (!this.settings.ANIMATER) return this.submit(() => this.renderRegion(region));
    // Dispatch while the source still exists. Tile writes stay serialized, but
    // Toolbelt's template removal must not cancel an opted-in Animater recipe.
    dispatchTileVisual({ id: this.owner.replace(/^spell-arsenal:/, ''), spell: this.settings.SPELL_NAME, kind: this.kind }, async () => {
      await this.animateRegion(region);
      return this.submit(() => this.renderRegion(region, true));
    }).catch(error => this.report(error));
  }

  animateRegion(region) {
    if (!this.settings.ANIMATER) return;
    if (this.animationTasks.has(region)) return this.animationTasks.get(region);
    const skipped = !this.enabled ? 'Mapping stopped' : !authorized() ? 'Requires active GM' :
      !region.parent.regions.has(region.id) ? 'Source area already removed' :
      this.adapter.placementPending(region) ? 'Template placement still pending' :
      this.finished.has(region.uuid) ? 'Area visual already expired' : !this.visible(region) ? 'Area outside active canvas level' : null;
    if (skipped) { recordAnimation(this.settings.SPELL_NAME, 'Skipped', skipped, region.uuid); return; }
    const spell = this.adapter.regionCastSpell(region);
    const message = region.message ?? game.messages?.get(region.flags?.[game.system.id]?.messageId);
    const origin = this.adapter.regionOrigin(region);
    const event = { type: 'template', item: spell, actor: spell?.actor ?? message?.actor, template: region, sceneId: region.parent.id,
      castRank: Number(origin?.castRank ?? spell?.rank) || undefined,
      tokenId: message?.speaker?.scene === region.parent.id ? message.speaker.token : undefined };
    const task = (async () => {
      recordAnimation(this.settings.SPELL_NAME, 'Targeting', 'Waiting for Toolbelt targets', region.uuid);
      const targeting = await waitForToolbeltTargets(region);
      const canceled = !this.enabled ? 'Mapping stopped during targeting' : !authorized() ? 'Active GM changed during targeting' :
        !this.visible(region) ? 'Canvas level changed during targeting' :
        targeting.handled && !targeting.targets?.length ? 'Toolbelt canceled or selected no targets' :
        !targeting.handled && !region.parent.regions.has(region.id) ? 'Area removed without target confirmation' : null;
      if (canceled) { recordAnimation(this.settings.SPELL_NAME, 'Skipped', canceled, region.uuid); return; }
      const tokens = targeting.handled ? [...region.parent.tokens].filter(token => targeting.targets.includes(token.uuid)) : areaEnemyTokens(region, spell);
      // Template recipes can contain projectiles and target motion as well as
      // area effects. Supply the completed selection instead of an empty array.
      if (targeting.handled) this.confirmedAnimationRegions.add(region);
      await this.animate(region.uuid, event, { targets: tokens.map(token => token.object).filter(Boolean) });
    })();
    this.animationTasks.set(region, task);
    task.catch(error => this.report(error));
    return task;
  }

  async renderRegion(region, dispatched = false) {
    if (!dispatched) return dispatchTileVisual({ id: this.owner.replace(/^spell-arsenal:/, ''), spell: this.settings.SPELL_NAME, kind: this.kind }, () => this.renderRegion(region, true));
    await this.animateRegion(region);
    // Toolbelt may remove a confirmed instant template during Animater playback.
    // Keep its snapshot for the following Tile Arsenal visual and normal expiry.
    const sourceAvailable = () => region.parent.regions.has(region.id) || this.confirmedAnimationRegions.has(region);
    if (!this.enabled || !authorized() || !sourceAvailable() || this.adapter.placementPending(region) || this.finished.has(region.uuid)) return;
    if (!this.visible(region)) { await this.erase(region.parent, region.id); return; }
    if (canvas.grid.isGridless) throw new Error('Spell visuals require a grid.');
    // Region creation can precede canvas coverage preparation.
    let coverage = regionCoverage(region, canvas.level, canvas.grid);
    for (let attempt = 0; !coverage && attempt < 5; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (!this.enabled || !authorized() || !sourceAvailable() || !this.visible(region) || this.adapter.placementPending(region)) return;
      coverage = regionCoverage(region, canvas.level, canvas.grid);
    }
    // Inapplicable or still preparing coverage can be retried by region updates/canvasReady.
    if (!coverage) return;
    const cells = [...coverage.covered].filter(offset => !region.flags?.world?.spellArsenalSuperseded?.[`${canvas.level.id}:${offset.i}:${offset.j}`]);
    if (cells.length > 120) throw new Error('Spell areas support up to 120 cells.');
    const ground = Math.max(canvas.level.elevation.base, Number.isFinite(region.elevation.bottom) ? region.elevation.bottom : canvas.level.elevation.base);
    const spell = this.adapter.regionSpell(region);
    const created = await this.createVisuals(region.parent, region.id, cells, (data, type) => {
      data.hidden = region.hidden;
      data.elevation = type === 'Region' ? { bottom: ground, top: ground, topInclusive: true } : ground;
    }, this.lifetime(region), spellStageRank(spell, this.adapter.regionOrigin(region)));
    if (!created) { this.finished.add(region.uuid); await this.restoreOverlay(region); return; }
    if (!sourceAvailable() || !this.enabled || !authorized()) { await this.erase(region.parent, region.id); return; }
    if (region.parent.regions.has(region.id) && this.settings.REGION_HIGHLIGHT_ONLY_WHILE_EDITING && region.visibility !== CONST.REGION_VISIBILITY.LAYER) {
      const saved = region.flags?.world?.spellArsenalHighlight;
      if (!saved || saved.owner === this.owner) await region.update({ visibility: CONST.REGION_VISIBILITY.LAYER,
        'flags.world.spellArsenalHighlight': saved ?? { owner: this.owner, visibility: region.visibility } });
    }
  }

  async restoreOverlay(region) {
    if (!authorized()) return;
    const saved = region.flags?.world?.spellArsenalHighlight;
    if (saved?.owner !== this.owner || !region.parent.regions.has(region.id)) return;
    const changes = { 'flags.world.-=spellArsenalHighlight': null };
    if (region.visibility === CONST.REGION_VISIBILITY.LAYER) changes.visibility = saved.visibility;
    await region.update(changes);
  }

  async pickCells(message) {
    const scene = canvas.scene, level = canvas.level, caster = message.token;
    if (!canvas.ready || !caster || caster.parent !== scene || caster.level !== level?.id || canvas.grid.isGridless) throw new Error('View the caster on a gridded scene before choosing cells.');
    const cells = [];
    const marker = `${this.owner}:${message.id}`;
    this.cancelPicker = () => {
      if (canvas.regions?._placementContext?.preview?.document?.flags.world?.spellArsenalPicker === marker) canvas.regions._cancelPlacement();
    };
    try {
      ui.notifications.info(`Choose ${this.settings.FREEFORM_SQUARES} touching cells. Escape cancels.`);
      while (this.enabled && authorized() && cells.length < this.settings.FREEFORM_SQUARES) {
        const preview = await canvas.regions.placeRegion({ name: this.settings.SPELL_NAME, shapes: [{ type: 'grid', offsets: [{ i: 0, j: 0 }] }], flags: { world: { spellArsenalPicker: marker } } }, { create: false });
        if (!preview || !this.enabled || !authorized()) return;
        if (canvas.scene !== scene || canvas.level?.id !== level.id) throw new Error('Placement scene changed.');
        const cell = preview.shapes[0].toObject().offsets[0];
        if (cells.some(other => other.i === cell.i && other.j === cell.j)) continue;
        const neighbors = other => canvas.grid.isSquare ? Math.abs(other.i - cell.i) + Math.abs(other.j - cell.j) === 1
          : canvas.grid.getAdjacentOffsets(other).some(adjacent => adjacent.i === cell.i && adjacent.j === cell.j);
        if (cells.length && !cells.some(neighbors)) { ui.notifications.warn('Choose a cell touching the selected area.'); continue; }
        cells.push({ i: cell.i, j: cell.j });
      }
      if (!this.enabled || !authorized()) return;
      await scene.createEmbeddedDocuments('Region', [{ name: this.settings.SPELL_NAME, shapes: [{ type: 'grid', offsets: cells }], levels: [level.id],
        color: game.user.color.toString(), elevation: { bottom: caster.elevation, top: caster.elevation, topInclusive: true },
        visibility: CONST.REGION_VISIBILITY.ALWAYS, highlightMode: 'coverage',
        flags: this.adapter.placementFlags(message) }]);
    } finally { this.cancelPicker = null; }
  }

  async stop(cleanup = true) {
    this.enabled = false;
    for (const [event, id] of this.hooks) Hooks.off(event, id);
    this.hooks.length = 0;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.cancelPicker?.();
    await this.pickerTask;
    await this.queue;
    if (!cleanup || !authorized()) return;
    for (const scene of game.scenes) {
      await this.erase(scene);
      for (const region of scene.regions) await this.restoreOverlay(region);
    }
  }
}

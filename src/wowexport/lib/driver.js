/*!
	hated-wow-mcp headless model export driver.
	Wires the ported wow.export CASC reader and M2/WMO exporters together.
	wow.export (https://github.com/Kruithne/wow.export), Authors: Kruithne, Marlamin. License: MIT
 */
const path = require('path');
const core = require('./core');
const constants = require('./constants');
const listfile = require('./casc/listfile');
const ExportHelper = require('./casc/export-helper');
const CASCLocal = require('./casc/casc-source-local');
const M2Exporter = require('./3D/exporters/M2Exporter');
const WMOExporter = require('./3D/exporters/WMOExporter');

let cascKey = null;
let casc = null;

// Stand-in for wow.export's progress/cancel helper.
const makeHelper = () => ({
	isCancelled: () => false,
	setCurrentTaskName() {},
	setCurrentTaskMax() {},
	setCurrentTaskValue() {},
	clearCurrentTask() {},
});

/**
 * Open the local CASC storage (cached per game root + product).
 * @param {{gameRoot: string, listfileCsv: string, product?: string}} opts
 */
const open = async (opts) => {
	const key = opts.gameRoot + '|' + (opts.product ?? '');
	if (casc !== null && cascKey === key)
		return casc;

	if (!listfile.isLoaded())
		await listfile.load(opts.listfileCsv);

	const source = new CASCLocal(opts.gameRoot);
	await source.init();

	let index = 0;
	if (opts.product) {
		index = source.builds.findIndex(b => b.Product === opts.product);
		if (index < 0)
			throw new Error('Product ' + opts.product + ' not found in .build.info (have ' + source.builds.map(b => b.Product).join(', ') + ')');
	}

	await source.load(index);
	casc = source;
	cascKey = key;
	return casc;
};

const MAGIC_M2 = [constants.MAGIC.MD20, constants.MAGIC.MD21];

/** @returns {'m2'|'wmo'|'m3'|'unknown'} */
const detectType = (data) => {
	const magic = data.readUInt32LE();
	data.seek(0);
	if (MAGIC_M2.includes(magic))
		return 'm2';
	if (magic === constants.MAGIC.M3DT)
		return 'm3';
	if (magic === 0x4D564552) // 'MVER'
		return 'wmo';
	return 'unknown';
};

/**
 * Export one model. Returns the written model path.
 * @param {{fileDataID: number, outDir: string, format?: string, animations?: boolean, splitGroups?: boolean}} opts
 */
const exportModel = async (opts) => {
	if (casc === null)
		throw new Error('CASC not open');

	const cfg = core.view.config;
	cfg.exportDirectory = path.resolve(opts.outDir);
	cfg.modelsExportAnimations = opts.animations !== false;
	cfg.modelsExportSplitWMOGroups = !!opts.splitGroups;

	const fileDataID = opts.fileDataID;
	const data = await casc.getFile(fileDataID);
	const type = detectType(data);
	const name = listfile.getByIDOrUnknown(fileDataID, type === 'wmo' ? '.wmo' : '.m2');
	const helper = makeHelper();
	const manifest = [];
	const format = (opts.format ?? (type === 'wmo' ? 'obj' : 'gltf')).toLowerCase();

	let out = ExportHelper.getExportPath(name);

	if (type === 'm2') {
		const exporter = new M2Exporter(data, [], fileDataID);
		if (format === 'gltf' || format === 'glb') {
			out = ExportHelper.replaceExtension(out, '.' + format);
			await exporter.exportAsGLTF(out, helper, format);
		} else if (format === 'obj') {
			out = ExportHelper.replaceExtension(out, '.obj');
			await exporter.exportAsOBJ(out, cfg.modelsExportCollision, helper, manifest);
		} else {
			throw new Error('Unsupported M2 format ' + format);
		}
	} else if (type === 'wmo') {
		const exporter = new WMOExporter(data, fileDataID);
		if (format === 'obj') {
			out = ExportHelper.replaceExtension(out, '.obj');
			await exporter.exportAsOBJ(out, helper, manifest, cfg.modelsExportSplitWMOGroups);
		} else if (format === 'gltf' || format === 'glb') {
			out = ExportHelper.replaceExtension(out, '.' + format);
			await exporter.exportAsGLTF(out, helper, format);
		} else {
			throw new Error('Unsupported WMO format ' + format);
		}
		WMOExporter.clearCache();
	} else {
		throw new Error('File ' + fileDataID + ' is not an M2 or WMO model (type: ' + type + ')');
	}

	return { path: out, type, name, files: manifest };
};

const DBCreatures = require('./db/caches/DBCreatures');
const DBCreatureList = require('./db/caches/DBCreatureList');
const DBCreatureDisplayExtra = require('./db/caches/DBCreatureDisplayExtra');
const DBCharacterCustomization = require('./db/caches/DBCharacterCustomization');
const BLPFile = require('./casc/blp');

let creaturesReady = false;
const loadCreatures = async () => {
	if (casc === null)
		throw new Error('CASC not open');
	if (creaturesReady)
		return;
	await DBCreatures.initializeCreatureData();
	await DBCreatureList.initialize_creature_list();
	creaturesReady = true;
};

/**
 * Find creatures by name fragment, creature id, or display id.
 * @param {{query: string, limit?: number}} opts
 */
const searchCreatures = async ({ query, limit = 40 }) => {
	await loadCreatures();
	const q = String(query).toLowerCase().trim();
	const out = [];
	const describe = (c) => {
		const info = DBCreatures.getDisplayInfo(c.displayID);
		const fdid = DBCreatures.getFileDataIDByDisplayID(c.displayID);
		return {
			id: c.id, name: c.name, displayID: c.displayID, fileDataID: fdid,
			model: fdid ? listfile.getByID(fdid) : undefined,
			humanoid: (info?.extendedDisplayInfoID ?? 0) > 0,
		};
	};

	if (/^\d+$/.test(q)) {
		const c = DBCreatureList.get_creature_by_id(Number(q));
		if (c)
			out.push(describe(c));
		if (out.length === 0) {
			const fdid = DBCreatures.getFileDataIDByDisplayID(Number(q));
			if (fdid)
				out.push({ id: 0, name: '(display ' + q + ')', displayID: Number(q), fileDataID: fdid, model: listfile.getByID(fdid), humanoid: false });
		}
		return out;
	}

	const exact = [];
	for (const c of DBCreatureList.get_all_creatures().values()) {
		const n = c.name.toLowerCase();
		if (n === q)
			exact.push(c);
		else if (n.includes(q) && out.length < limit * 4)
			out.push(c);
	}

	return [...exact, ...out].filter(c => c.displayID > 0).slice(0, limit).map(describe);
};

/**
 * Export a creature with its skin. Humanoid NPCs (character-model displays) are
 * not supported yet and are reported as such.
 * @param {{creatureId?: number, displayId?: number, outDir: string, format?: string, animations?: boolean}} opts
 */
const exportCreature = async (opts) => {
	await loadCreatures();

	let displayID = opts.displayId;
	let name = null;
	if (opts.creatureId !== undefined) {
		const c = DBCreatureList.get_creature_by_id(opts.creatureId);
		if (!c)
			throw new Error('Unknown creature id ' + opts.creatureId);
		displayID = c.displayID;
		name = c.name;
	}

	const info = DBCreatures.getDisplayInfo(displayID);
	const fileDataID = DBCreatures.getFileDataIDByDisplayID(displayID);
	if (!info || !fileDataID)
		throw new Error('No model for display id ' + displayID);

	const cfg = core.view.config;
	cfg.exportDirectory = path.resolve(opts.outDir);
	cfg.modelsExportAnimations = opts.animations !== false;

	const humanoid = info.extendedDisplayInfoID > 0;
	let modelFileDataID = fileDataID;
	let extra = null;
	let choices = [];
	let layoutID = 0;

	if (humanoid) {
		// NPC built from a player race model: pick the race/sex model, then
		// apply the NPC's customization choices and baked skin.
		await DBCharacterCustomization.ensureInitialized();
		await DBCreatureDisplayExtra.ensureInitialized();
		extra = DBCreatureDisplayExtra.get_extra(info.extendedDisplayInfoID);
		if (!extra)
			throw new Error('No extended display info for display ' + displayID);

		const chrModelID = DBCharacterCustomization.get_chr_model_id(extra.DisplayRaceID, extra.DisplaySexID);
		modelFileDataID = chrModelID !== undefined ? DBCharacterCustomization.get_model_file_data_id(chrModelID) : undefined;
		if (!modelFileDataID)
			throw new Error('No character model for race ' + extra.DisplayRaceID + ' sex ' + extra.DisplaySexID);

		layoutID = DBCharacterCustomization.get_texture_layout_id(chrModelID);
		choices = DBCreatureDisplayExtra.get_customization_choices(info.extendedDisplayInfoID);
	}

	const data = await casc.getFile(modelFileDataID);
	const exporter = new M2Exporter(data, info.textures, modelFileDataID);

	await exporter.m2.load();
	const skin = await exporter.m2.getSkin(0);
	const geosets = skin.subMeshes.map(sm => ({ id: sm.submeshID, checked: false }));

	if (humanoid) {
		// Ported from wow.export's apply_customization_geosets.
		for (const g of geosets) {
			const s = g.id.toString();
			const isDefault = (g.id === 0 || s.endsWith('01') || s.startsWith('32'));
			g.checked = isDefault && !(s.startsWith('17') || s.startsWith('35'));
		}

		for (const active of choices) {
			const available = DBCharacterCustomization.get_choices_for_option(active.optionID);
			if (!available)
				continue;

			for (const choice of available) {
				const geosetValue = DBCharacterCustomization.get_geoset_value(DBCharacterCustomization.get_choice_geoset_raw(choice.id));
				if (geosetValue === undefined)
					continue;

				for (const g of geosets) {
					if (g.id !== 0 && g.id === geosetValue)
						g.checked = choice.id === active.choiceID;
				}
			}
		}

		// Baked NPC skin goes on the lowest character texture type, as the app does.
		const bakeID = extra.HDBakeMaterialResourcesID || extra.BakeMaterialResourcesID;
		const bakeFDID = bakeID > 0 ? DBCharacterCustomization.get_texture_file_data_id(bakeID) : undefined;
		if (bakeFDID) {
			let textureType = 0;
			const types = [];
			for (const [key, value] of DBCharacterCustomization.get_model_material_map().entries()) {
				if (key.startsWith(layoutID + '-'))
					types.push(value.TextureType);
			}
			types.sort((a, b) => a - b);
			if (types.length > 0)
				textureType = types[0];

			const png = new BLPFile(await casc.getFile(bakeFDID)).toPNG(0b1111, 0);
			exporter.addURITexture(textureType, 'data:image/png;base64,' + png.toBase64());
		}
	} else {
		// Same geoset rules as wow.export's creature tab.
		for (const g of geosets) {
			if (info.extraGeosets !== undefined)
				g.checked = info.extraGeosets.includes(g.id) || g.id === 0 || g.id >= 900;
			else
				g.checked = g.id.toString().endsWith('0') || g.id.toString().endsWith('01');
		}
	}

	exporter.setGeosetMask(geosets);

	const format = (opts.format ?? 'gltf').toLowerCase();
	const label = ExportHelper.sanitizeFilename(name ?? ('display_' + displayID)) + '_' + displayID;
	// Humanoids get their own folder: the baked skin is written beside the model.
	let out = ExportHelper.getExportPath('creatures/' + (humanoid ? label + '/' : '') + label + '.m2');
	out = ExportHelper.replaceExtension(out, '.' + format);

	const helper = makeHelper();
	if (format === 'gltf' || format === 'glb')
		await exporter.exportAsGLTF(out, helper, format);
	else if (format === 'obj')
		await exporter.exportAsOBJ(out, cfg.modelsExportCollision, helper, []);
	else
		throw new Error('Unsupported format ' + format);

	return { path: out, type: 'm2', name: label, files: [], displayID, fileDataID, textures: info.textures };
};

/** Decode a BLP to PNG on disk. */
const exportTexture = async (spec, outDir) => {
	if (casc === null)
		throw new Error('CASC not open');

	const fileDataID = /^\d+$/.test(String(spec)) ? Number(spec) : listfile.getByFilename(String(spec));
	if (fileDataID === undefined)
		throw new Error('Unknown texture: ' + spec);

	const BLPFile = require('./casc/blp');
	const cfg = core.view.config;
	cfg.exportDirectory = path.resolve(outDir);

	const data = await casc.getFile(fileDataID);
	const blp = new BLPFile(data);
	const name = listfile.getByIDOrUnknown(fileDataID, '.blp');
	const out = ExportHelper.replaceExtension(ExportHelper.getExportPath(name), '.png');
	await blp.saveToPNG(out, 0b1111);
	return out;
};

module.exports = { open, exportModel, exportTexture, searchCreatures, exportCreature, listfile, getCasc: () => casc };

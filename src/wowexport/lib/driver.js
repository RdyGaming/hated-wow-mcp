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

module.exports = { open, exportModel, exportTexture, listfile, getCasc: () => casc };

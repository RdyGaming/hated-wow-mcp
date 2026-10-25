/*!
	Headless shim for the wow.export module of the same name.
	wow.export (https://github.com/Kruithne/wow.export), Authors: Kruithne, Marlamin. License: MIT
 */
const { EventEmitter } = require('events');

// Stand-in for wow.export's Vue app state. Only the fields the exporters read.
const view = {
	config: {
		cascLocale: 2,
		exportDirectory: '',
		enableSharedTextures: true,
		enableSharedChildren: true,
		enableAbsoluteMTLPaths: false,
		enableAbsoluteGLTFPaths: false,
		enableAbsoluteCSVPaths: false,
		removePathSpaces: true,
		exportTextureFormat: 'PNG',
		overwriteFiles: true,
		exportM2Bones: false,
		exportM2Meta: true,
		exportWMOMeta: true,
		modelsExportCollision: false,
		modelsExportPngIncrements: true,
		modelsExportSkin: false,
		modelsExportSkel: false,
		modelsExportBone: false,
		modelsExportAnim: false,
		modelsExportWMOGroups: false,
		modelsExportSplitWMOGroups: false,
		modelsExportUV2: false,
		modelsExportTextures: true,
		modelsExportAlpha: true,
		modelsExportAnimations: false,
		modelsExportApplyPose: true,
		modelsExportWithBonePrefix: true,
		// forward slashes in MTL paths: Blender's importer mangles backslash-relative ones
		pathFormat: 'posix',
	},
	casc: null,
	exportCancelled: false,
	isBusy: 0,
};

const events = new EventEmitter();
const noop = () => {};

module.exports = {
	view,
	events,
	setToast: noop,
	hideToast: noop,
	openExportDirectory: noop,
	showLoadingScreen: noop,
	hideLoadingScreen: noop,
	progressLoadingScreen: async () => {},
	block: async (fn) => fn(),
};

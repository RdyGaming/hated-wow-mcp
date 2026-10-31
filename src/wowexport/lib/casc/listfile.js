/*!
	Headless shim for the wow.export module of the same name.
	wow.export (https://github.com/Kruithne/wow.export), Authors: Kruithne, Marlamin. License: MIT
 */
const fs = require('fs');
const readline = require('readline');
const ExportHelper = require('./export-helper');

// Community listfile (id;path per line), loaded from a local csv.
let idToName = new Map();
let nameToId = null;
let loaded = false;

const load = async (csvPath) => {
	idToName = new Map();
	nameToId = null;
	const rl = readline.createInterface({ input: fs.createReadStream(csvPath), crlfDelay: Infinity });
	for await (const line of rl) {
		const sep = line.indexOf(';');
		if (sep < 1)
			continue;
		idToName.set(parseInt(line.substring(0, sep)), line.substring(sep + 1).toLowerCase());
	}
	loaded = true;
};

const buildReverse = () => {
	nameToId = new Map();
	for (const [id, name] of idToName)
		nameToId.set(name, id);
};

const getByID = (id) => idToName.get(id);

const formatUnknownFile = (fileDataID, ext = '') => 'unknown/' + fileDataID + ext;

const getByIDOrUnknown = (id, ext = '') => getByID(id) ?? formatUnknownFile(id, ext);

const getByFilename = (filename) => {
	filename = filename.toLowerCase().replaceAll('\\', '/');
	if (nameToId === null)
		buildReverse();

	const hit = nameToId.get(filename);
	if (hit === undefined && (filename.endsWith('.mdl') || filename.endsWith('mdx')))
		return getByFilename(ExportHelper.replaceExtension(filename, '.m2'));

	return hit;
};

const isLoaded = () => loaded;
const entries = () => idToName.entries();

module.exports = { load, getByID, getByIDOrUnknown, getByFilename, formatUnknownFile, isLoaded, entries };

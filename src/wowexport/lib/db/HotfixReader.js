/*!
	hated-wow-mcp: reader for the client's hotfix cache (Cache/ADB/<locale>/DBCache.bin, "XFTH").
	Blizzard ships new and changed DB2 rows to the client as hotfixes; on WoW Forever every new item
	lives only here, not in the CASC DB2 files. Rows are decoded with the WoWDBDefs layout for the
	build the CASC table reports.
 */
const fs = require('fs');
const path = require('path');
const core = require('../core');
const constants = require('../constants');
const BufferWrapper = require('../buffer');
const DBDParser = require('./DBDParser');

const MAGIC = 0x48544658; // 'XFTH'
const ENTRY_SIZE = 32;
const STATUS_VALID = 1;
const STATUS_DELETED = 2;

/**
 * Table hash and DBD layout for a table, taken from its CASC DB2 header.
 * @param {string} tableName
 */
const tableLayout = async (tableName) => {
	const data = await core.view.casc.getVirtualFileByName('DBFilesClient/' + tableName + '.db2', false);
	const magic = data.readUInt32LE();
	if (magic === 0x35434457) { // WDC5
		data.readUInt32LE();
		data.readUInt8(128);
	}
	data.move(16); // recordCount, fieldCount, recordSize, stringTableSize
	const tableHash = data.readUInt32LE();
	const layoutHash = data.readUInt8(4).reverse().map(e => e.toString(16).padStart(2, '0')).join('').toUpperCase();

	const dbdPath = path.join(constants.DATA_PATH, 'dbd', tableName + '.dbd');
	let raw;
	try {
		raw = await BufferWrapper.readFile(dbdPath);
	} catch (e) {
		throw new Error('Missing table definition ' + tableName + '.dbd (expected at ' + dbdPath + '). Run the model-data sync.');
	}
	const structure = new DBDParser(raw).getStructure(core.view.casc.getBuildName(), layoutHash);
	if (!structure)
		throw new Error('No ' + tableName + ' definition for build ' + core.view.casc.getBuildName() + ' layout ' + layoutHash);
	return { tableHash, fields: [...structure.fields] };
};

const decodeRow = (buf, off, end, fields) => {
	const row = {};
	for (const f of fields) {
		if (!f.isInline)
			continue;
		const count = f.arrayLength > -1 ? f.arrayLength : 1;
		const values = [];
		for (let i = 0; i < count; i++) {
			if (f.type === 'string' || f.type === 'locstring') {
				let z = off;
				while (z < end && buf[z] !== 0)
					z++;
				values.push(buf.toString('utf8', off, z));
				off = z + 1;
			} else if (f.type === 'float') {
				values.push(buf.readFloatLE(off));
				off += 4;
			} else {
				const bytes = (f.size > 0 ? f.size : 32) / 8;
				if (bytes === 8)
					values.push(Number(f.isSigned ? buf.readBigInt64LE(off) : buf.readBigUInt64LE(off)));
				else
					values.push(f.isSigned ? buf.readIntLE(off, bytes) : buf.readUIntLE(off, bytes));
				off += bytes;
			}
		}
		row[f.name] = count === 1 ? values[0] : values;
	}
	return { row, end: off };
};

/**
 * Read every hotfix row for one table. Later pushes win; deleted records are dropped.
 * @param {string} cachePath Path to DBCache.bin.
 * @param {string} tableName DB2 table name, e.g. ItemSparse.
 * @returns {Promise<{ rows: Map<number, object>, deleted: Set<number>, build: number, skipped: number }>}
 */
const readHotfixTable = async (cachePath, tableName) => {
	const buf = fs.readFileSync(cachePath);
	if (buf.length < 44 || buf.readUInt32LE(0) !== MAGIC)
		throw new Error(cachePath + ' is not a hotfix cache (no XFTH header).');
	const version = buf.readUInt32LE(4);
	if (version !== 9)
		throw new Error('Unsupported hotfix cache version ' + version + ' (this reader knows version 9).');
	const build = buf.readUInt32LE(8);

	const { tableHash, fields } = await tableLayout(tableName);
	const rows = new Map();
	const pushes = new Map();
	const deleted = new Set();
	let skipped = 0;
	let pos = 44;
	while (pos + ENTRY_SIZE <= buf.length) {
		if (buf.readUInt32LE(pos) !== MAGIC)
			throw new Error('Hotfix cache entry out of sync at byte ' + pos);
		const push = buf.readInt32LE(pos + 4);
		const hash = buf.readUInt32LE(pos + 16);
		const recordID = buf.readUInt32LE(pos + 20);
		const size = buf.readUInt32LE(pos + 24);
		const status = buf.readUInt32LE(pos + 28);
		const start = pos + ENTRY_SIZE;
		pos = start + size;
		if (hash !== tableHash)
			continue;
		if ((pushes.get(recordID) ?? -Infinity) > push)
			continue;
		pushes.set(recordID, push);
		if (status === STATUS_VALID && size > 0) {
			const { row, end } = decodeRow(buf, start, start + size, fields);
			if (end !== start + size) {
				skipped++;
				continue;
			}
			row.ID = recordID;
			rows.set(recordID, row);
			deleted.delete(recordID);
		} else if (status === STATUS_DELETED) {
			rows.delete(recordID);
			deleted.add(recordID);
		}
	}
	return { rows, deleted, build, skipped };
};

module.exports = { readHotfixTable };

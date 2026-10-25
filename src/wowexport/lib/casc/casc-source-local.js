/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>, Marlamin <marlamin@marlamin.com>
	License: MIT

	Local-install-only variant for hated-wow-mcp: no CDN fallback, no build
	cache, no UI progress. Parsing of the journal indexes, encoding table and
	root file is unchanged from upstream.
 */
const path = require('path');
const fsp = require('fs').promises;
const log = require('../log');
const constants = require('../constants');
const CASC = require('./casc-source');
const VersionConfig = require('./version-config');
const CDNConfig = require('./cdn-config');
const BufferWrapper = require('../buffer');
const BLTEReader = require('./blte-reader').BLTEReader;
const listfile = require('./listfile');
const core = require('../core');
const generics = require('../generics');

class CASCLocal extends CASC {
	/**
	 * @param {string} dir Product directory, e.g. ...\World of Warcraft\_retail_ (holds Data\).
	 * @param {string} [buildInfoDir] Directory holding .build.info (the game root). Defaults to the parent of dir.
	 */
	constructor(dir, buildInfoDir) {
		super(false);

		this.dir = dir;
		this.buildInfoDir = buildInfoDir ?? path.dirname(dir);
		this.dataDir = path.join(dir, constants.BUILD.DATA_DIR);
		this.storageDir = path.join(this.dataDir, 'data');

		this.localIndexes = new Map();
	}

	/**
	 * Read .build.info and list the products it knows about.
	 */
	async init() {
		const candidates = [path.join(this.dir, constants.BUILD.MANIFEST), path.join(this.buildInfoDir, constants.BUILD.MANIFEST)];
		let raw = null;
		for (const c of candidates) {
			try {
				raw = await fsp.readFile(c, 'utf8');
				break;
			} catch (e) {
				// try next
			}
		}

		if (raw === null)
			throw new Error('No .build.info found next to ' + this.dir);

		const config = VersionConfig(raw);
		this.builds = config.filter(entry => constants.PRODUCTS.some(e => e.product === entry.Product));
	}

	/**
	 * Load one build: configs, indexes, encoding table and root file.
	 * @param {number} buildIndex
	 */
	async load(buildIndex = 0) {
		this.build = this.builds[buildIndex];
		if (!this.build)
			throw new Error('No known product in .build.info');

		this.buildConfig = CDNConfig(await fsp.readFile(this.formatConfigPath(this.build.BuildKey), 'utf8'));
		this.cdnConfig = CDNConfig(await fsp.readFile(this.formatConfigPath(this.build.CDNKey), 'utf8'));

		await this.loadIndexes();
		await this.loadEncoding();
		await this.loadRoot();

		core.view.casc = this;
	}

	/**
	 * Obtain a file by its fileDataID.
	 * @param {number} fileDataID
	 * @param {boolean} [partialDecryption=false]
	 * @param {boolean} [suppressLog=false]
	 * @param {boolean} [supportFallback=true] Ignored, kept for upstream call compatibility.
	 * @param {boolean} [forceFallback=false] Ignored.
	 * @param {string} [contentKey=null]
	 */
	async getFile(fileDataID, partialDecryption = false, suppressLog = false, supportFallback = true, forceFallback = false, contentKey = null) {
		if (!suppressLog)
			log.write('Loading local CASC file %d (%s)', fileDataID, listfile.getByID(fileDataID));

		const encodingKey = contentKey !== null ? super.getEncodingKeyForContentKey(contentKey) : await super.getFile(fileDataID);
		const data = await this.getDataFile(encodingKey);
		return new BLTEReader(data, encodingKey, partialDecryption);
	}

	/**
	 * Load and parse storage indexes from the local installation.
	 */
	async loadIndexes() {
		const entries = await fsp.readdir(this.storageDir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith('.idx'))
				await this.parseIndex(path.join(this.storageDir, entry.name));
		}
	}

	/**
	 * Parse a local installation journal index for entries.
	 * @param {string} file Path to the index.
	 */
	async parseIndex(file) {
		const entries = this.localIndexes;
		const index = await BufferWrapper.readFile(file);

		const headerHashSize = index.readInt32LE();
		index.move(4); // headerHash uint32
		index.move(headerHashSize); // headerHash byte[headerHashSize]

		index.seek((8 + headerHashSize + 0x0F) & 0xFFFFFFF0); // Next 0x10 boundary.

		const dataLength = index.readInt32LE();
		index.move(4);

		const nBlocks = dataLength / 18;
		for (let i = 0; i < nBlocks; i++) {
			const key = index.readHexString(9);
			if (entries.has(key)) {
				index.move(1 + 4 + 4); // idxHigh + idxLow + size
				continue;
			}

			const idxHigh = index.readUInt8();
			const idxLow = index.readInt32BE();

			entries.set(key, {
				index: (idxHigh << 2 | ((idxLow & 0xC0000000) >>> 30)),
				offset: idxLow & 0x3FFFFFFF,
				size: index.readInt32LE()
			});
		}
	}

	async loadEncoding() {
		const encKeys = this.buildConfig.encoding.split(' ');
		const encRaw = await this.getDataFile(encKeys[1]);
		await this.parseEncodingFile(encRaw, encKeys[1]);
	}

	async loadRoot() {
		const rootKey = this.encodingKeys.get(this.buildConfig.root);
		if (rootKey === undefined)
			throw new Error('No encoding entry found for root key');

		const root = await this.getDataFile(rootKey);
		await this.parseRootFile(root, rootKey);
	}

	/**
	 * Obtain a BLTE-wrapped data file from the local archives.
	 * @param {string} key
	 */
	async getDataFile(key) {
		const entry = this.localIndexes.get(key.substring(0, 18));
		if (!entry)
			throw new Error('Requested file does not exist in local data: ' + key);

		const data = await generics.readFile(this.formatDataPath(entry.index), entry.offset + 0x1E, entry.size - 0x1E);

		let isZeroed = true;
		for (let i = 0, n = data.remainingBytes; i < n; i++) {
			if (data.readUInt8() !== 0x0) {
				isZeroed = false;
				break;
			}
		}

		if (isZeroed)
			throw new Error('Requested data file is empty or missing: ' + key);

		data.seek(0);
		return data;
	}

	formatDataPath(id) {
		return path.join(this.dataDir, 'data', 'data.' + id.toString().padStart(3, '0'));
	}

	formatConfigPath(key) {
		return path.join(this.dataDir, 'config', this.formatCDNKey(key));
	}

	formatCDNKey(key) {
		return path.join(key.substring(0, 2), key.substring(2, 4), key);
	}

	getBuildName() {
		return this.build.Version;
	}

	getBuildKey() {
		return this.build.BuildKey;
	}
}

module.exports = CASCLocal;

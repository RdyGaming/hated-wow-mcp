/*!
	Headless shim for the wow.export module of the same name.
	wow.export (https://github.com/Kruithne/wow.export), Authors: Kruithne, Marlamin. License: MIT
 */
const fs = require('fs');
const path = require('path');
const constants = require('../constants');

const KEY_RING = {};

const getKey = (keyName) => KEY_RING[keyName.toLowerCase()];

// Keys for encrypted BLTE blocks come from tact.json in the data directory
// (a { "<16 hex name>": "<32 hex key>" } map), written by the sync step.
const load = () => {
	try {
		const keys = JSON.parse(fs.readFileSync(path.join(constants.DATA_PATH, 'tact.json'), 'utf8'));
		for (const [name, key] of Object.entries(keys)) {
			if (name.length === 16 && key.length === 32)
				KEY_RING[name.toLowerCase()] = key.toLowerCase();
		}
	} catch (e) {
		// No keys: encrypted blocks stay zeroed, same as wow.export without keys.
	}
};

load();

module.exports = { getKey, load };

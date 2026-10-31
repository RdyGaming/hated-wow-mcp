/*!
	Headless shim for the wow.export module of the same name.
	wow.export (https://github.com/Kruithne/wow.export), Authors: Kruithne, Marlamin. License: MIT
 */
const util = require('util');

const lines = [];
const debug = !!process.env.WOWEXPORT_DEBUG;
let markTimer = 0;

const write = (...parameters) => {
	const line = util.format(...parameters);
	if (lines.length < 2000)
		lines.push(line);
	if (debug)
		process.stderr.write(line + '\n');
};

const timeLog = () => { markTimer = Date.now(); };
const timeEnd = (label, ...params) => write(label + ' (%dms)', ...params, (Date.now() - markTimer));
const openRuntimeLog = () => {};

module.exports = { write, timeLog, timeEnd, openRuntimeLog, lines };

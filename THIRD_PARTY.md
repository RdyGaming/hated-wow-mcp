# Third-party code

## wow.export

The model exporter in `src/wowexport/lib/` is a headless port of
[wow.export](https://github.com/Kruithne/wow.export) by **Kruithne** and
**Marlamin**, taken at commit `c2fd7bde36a712be78a5da896c995b84fbfa2545`
(version 0.2.19). It is used under the MIT license; the full license text is in
`src/wowexport/WOW_EXPORT_LICENSE`.

Copied with small edits: the CASC reader (BLTE, encoding and root parsing, Salsa20),
the BLP decoder, the DB2/DBD reader, the M2, WMO, SKEL and ANIM loaders, the glTF,
GLB, OBJ, MTL, JSON, CSV and STL writers, and the M2 and WMO exporters.

Replaced or trimmed for this project: `core.js`, `log.js`, `constants.js`,
`casc/listfile.js`, `casc/tact-keys.js`, `casc/casc-source-local.js` (local install
only, no CDN fallback), the DBD loading in `db/WDCReader.js`, memory-mapped file
access, and WebP encoding. `driver.js` is new. The NW.js, Vue and WebGL parts of
wow.export are not included.

Files that carry the original wow.export header keep it. Files written for this
project say so in their own header.

## Data fetched at sync time

- [WoWDBDefs](https://github.com/wowdev/WoWDBDefs): DB2 column layouts.
- [TACTKeys](https://github.com/wowdev/TACTKeys): CASC decryption keys.
- [wow-listfile](https://github.com/wowdev/wow-listfile): FileDataID to path mapping.

None of this is Blizzard game data, and no game files are downloaded or shipped.

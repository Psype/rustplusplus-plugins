'use strict';

/*
 * Compatibility bridge for modules and tests which historically require index.ts.
 * Production starts index.js directly and publishes the live client into this object.
 */
module.exports = { client: null };

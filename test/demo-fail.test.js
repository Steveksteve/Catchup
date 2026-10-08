'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('demonstration : ce test echoue volontairement', () => {
  assert.equal(1 + 1, 3);
});

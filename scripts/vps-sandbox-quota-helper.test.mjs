import test from 'node:test';
import assert from 'node:assert/strict';
import {isMountpoint} from './vps-sandbox-quota-helper.mjs';

test('isMountpoint returns true when mountpoint exits successfully', () => {
  const execute = () => {};
  assert.equal(isMountpoint('/tmp/example', execute), true);
});

test('isMountpoint treats util-linux exit code 32 as not mounted', () => {
  const execute = () => {
    const error = new Error('not a mountpoint');
    error.status = 32;
    throw error;
  };
  assert.equal(isMountpoint('/tmp/example', execute), false);
});

test('isMountpoint propagates unexpected command failures', () => {
  const execute = () => {
    const error = new Error('permission denied');
    error.status = 1;
    throw error;
  };
  assert.throws(() => isMountpoint('/tmp/example', execute), /permission denied/);
});

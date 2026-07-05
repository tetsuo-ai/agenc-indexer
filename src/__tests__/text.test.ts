import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeOnChainText, isLegibleText } from '../text.js';

const FFFD = String.fromCharCode(0xfffd);
const SOH = String.fromCharCode(0x01);

/** Pad a UTF-8 string into a fixed 64-byte, NUL-terminated on-chain field. */
function descriptionBytes(text: string): Uint8Array {
  const buf = new Uint8Array(64);
  buf.set(new TextEncoder().encode(text).slice(0, 64));
  return buf;
}

test('isLegibleText gates real titles vs decoded binary', () => {
  assert.equal(isLegibleText('Write a fantasy story'), true);
  assert.equal(isLegibleText(`${FFFD} TQb${FFFD}CIFQ${FFFD}`), false);
  assert.equal(isLegibleText(`A${SOH}B`), false);
  assert.equal(isLegibleText(''), false);
});

test('decodeOnChainText returns legible titles and rejects binary -> null', () => {
  assert.equal(
    decodeOnChainText(descriptionBytes('Summarize one tech blog post')),
    'Summarize one tech blog post',
  );

  // Mostly-binary 64-byte buffer with one ASCII letter: the old
  // `/[\p{L}\p{N}]/` guard accepted it as a mojibake title; now it is null.
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 32; i++) bytes[i] = 0x80 + (i % 0x40);
  bytes[10] = 0x41;
  assert.equal(decodeOnChainText(bytes), null);

  assert.equal(decodeOnChainText(new Uint8Array(64)), null);
});

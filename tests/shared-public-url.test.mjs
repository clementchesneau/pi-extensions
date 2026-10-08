import assert from 'node:assert/strict';
import test from 'node:test';
import { checkedUrl, publicAddresses } from '../packages/shared/public-url.js';

test('outgoing URLs must be public HTTP(S) without credentials or an explicit port', () => {
  assert.equal(checkedUrl('https://example.com/a#part').href, 'https://example.com/a');
  assert.throws(() => checkedUrl('file:///etc/passwd'), /Only public HTTP\(S\) URLs/);
  assert.throws(() => checkedUrl('https://user:secret@example.com'), /credentials/);
  assert.throws(() => checkedUrl('https://example.com:8443'), /Nonstandard ports/);
});

test('every address of the host must be public, literal or resolved', async () => {
  assert.deepEqual(await publicAddresses(new URL('https://93.184.215.14')), [{ address: '93.184.215.14', family: 4 }]);
  await assert.rejects(publicAddresses(new URL('http://127.0.0.1')), /Non-public/);
  await assert.rejects(publicAddresses(new URL('http://[::ffff:10.0.0.1]')), /Non-public/);
  const mixed = async () => [
    { address: '93.184.215.14', family: 4 },
    { address: '192.168.1.2', family: 4 },
  ];
  await assert.rejects(publicAddresses(new URL('https://example.com'), { resolve: mixed }), /Non-public/);
});

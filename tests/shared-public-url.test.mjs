import assert from 'node:assert/strict';
import test from 'node:test';
import { checkedUrl, publicAddresses } from '../packages/shared/public-url.js';

test('outgoing URLs must be public HTTP(S) without credentials or an explicit port', () => {
  assert.equal(checkedUrl('https://example.com/a#part').href, 'https://example.com/a');
  assert.throws(() => checkedUrl('file:///etc/passwd'), /Only public HTTP\(S\) URLs/);
  assert.throws(() => checkedUrl('https://user:secret@example.com'), /credentials/);
  assert.throws(() => checkedUrl('https://example.com:8443'), /Nonstandard ports/);
});

test('standard NAT64 addresses targeting public IPv4 are accepted, literal or resolved', async () => {
  const translated = { address: '64:ff9b::6011:ce10', family: 6 };
  assert.deepEqual(await publicAddresses(new URL(`https://[${translated.address}]`)), [translated]);
  const addresses = [translated, { address: '96.17.206.16', family: 4 }];
  assert.deepEqual(
    await publicAddresses(new URL('https://example.com'), { resolve: async () => addresses }),
    addresses,
  );
});

test('NAT64 does not allow non-public IPv4 destinations or other translation prefixes', async () => {
  for (const address of [
    '64:ff9b::a00:1', // 10.0.0.1
    '64:ff9b::ac10:1', // 172.16.0.1
    '64:ff9b::c0a8:102', // 192.168.1.2
    '64:ff9b::7f00:1', // 127.0.0.1
    '64:ff9b::a9fe:a9fe', // 169.254.169.254
    '64:ff9b::6440:1', // 100.64.0.1
    '64:ff9b::', // 0.0.0.0
    '64:ff9b::e000:1', // 224.0.0.1
    '64:ff9b::ffff:ffff', // 255.255.255.255
    '64:ff9b:1::6011:ce10', // Local-use NAT64 prefix
    '2002:6011:ce10::', // 6to4
    '2001::6011:ce10', // Teredo
  ]) {
    await assert.rejects(publicAddresses(new URL(`https://[${address}]`)), /Non-public/, address);
  }
  const mixed = async () => [
    { address: '96.17.206.16', family: 4 },
    { address: '64:ff9b::7f00:1', family: 6 },
  ];
  await assert.rejects(publicAddresses(new URL('https://example.com'), { resolve: mixed }), /Non-public/);
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

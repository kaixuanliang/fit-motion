import { encryptText, decryptText, isEncrypted, randomSalt } from '../src/backup/crypto';

const salt = randomSalt();
const params = { salt, iterations: 310000 };
const text = JSON.stringify({ hello: '轨迹数据', points: 12345 });
const cipher = await encryptText(text, 'correct-horse-8', params);
console.log('encrypted prefix:', isEncrypted(cipher), 'len:', cipher.length, 'plain len:', text.length);
const plain = await decryptText(cipher, 'correct-horse-8', params);
console.log('roundtrip ok:', plain === text);
try {
  await decryptText(cipher, 'wrong-password', params);
  console.log('wrong password: PASSED (BAD)');
} catch (error) {
  console.log('wrong password rejected:', error instanceof Error ? error.message.slice(0, 40) : error);
}

/**
 * One-time script to generate a gramjs StringSession for Telegram MTProto user API.
 * 
 * Usage:
 *   1. Make sure TELEGRAM_API_ID and TELEGRAM_API_HASH are set in .env
 *   2. Run: npx tsx scripts/generate-session.ts
 *   3. Enter your phone number, verification code, and 2FA password if prompted
 *   4. Copy the printed session string into .env as TELEGRAM_SESSION_STRING=<value>
 *
 * Get your API_ID and API_HASH at: https://my.telegram.org/apps
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import * as readline from 'readline';
import dotenv from 'dotenv';

dotenv.config();

const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0');
const API_HASH = process.env.TELEGRAM_API_HASH || '';

if (!API_ID || !API_HASH) {
  console.error('\n❌ Missing TELEGRAM_API_ID or TELEGRAM_API_HASH in .env');
  console.error('   Get them at: https://my.telegram.org/apps\n');
  process.exit(1);
}

function input(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

console.log('\n🔐 Telegram MTProto Session Generator');
console.log('──────────────────────────────────────');
console.log(`API_ID: ${API_ID}`);
console.log(`API_HASH: ${API_HASH.slice(0, 4)}...${API_HASH.slice(-4)}\n`);

const session = new StringSession('');
const client = new TelegramClient(session, API_ID, API_HASH, { connectionRetries: 5 });

await client.start({
  phoneNumber: async () => input('📱 Phone number (with country code, e.g. +15551234567): '),
  password: async () => input('🔒 2FA Password (press Enter to skip): '),
  phoneCode: async () => input('📟 Verification code from Telegram: '),
  onError: (err) => console.error('Error:', err),
});

const sessionString = (client.session as StringSession).save();

console.log('\n✅ Authentication successful!\n');
console.log('══════════════════════════════════════════════════════════════');
console.log('SESSION STRING (add to .env):');
console.log('');
console.log(`TELEGRAM_SESSION_STRING=${sessionString}`);
console.log('══════════════════════════════════════════════════════════════');
console.log('\n⚠️  Keep this string SECRET — it grants full access to your Telegram account.\n');

await client.disconnect();
process.exit(0);

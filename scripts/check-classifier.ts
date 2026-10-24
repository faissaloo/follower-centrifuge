/**
 * MANUAL real-API check for the classifier providers (not part of the automated
 * test suite, which never touches the network).
 *
 * Reads keys from .typesafe-key / .deepseek-key (or TYPESAFE_API_KEY /
 * DEEPSEEK_API_KEY) and exercises the REAL classifier end-to-end:
 * TypeSafe Jev primary -> DeepSeek fallback -> five categories.
 *
 *   npm run check:classifier
 *
 * It sends only synthetic names — no Instagram data or cookies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createGenderClassifier, testDeepSeekConnection } from '../src/utils/gender-classifier';
import { DEFAULT_DEEPSEEK_CONFIG } from '../src/model/deepseek-config';
import { GenderInput } from '../src/model/gender';

function readKey(envName: string, fileName: string): string {
  const envKey = typeof process.env[envName] === 'string' ? process.env[envName].trim() : '';
  if (envKey !== '') {
    return envKey;
  }
  const keyFile = path.resolve(process.cwd(), fileName);
  if (fs.existsSync(keyFile)) {
    return fs.readFileSync(keyFile, 'utf8').trim();
  }
  return '';
}

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  } as Storage;
}

const USERS: readonly GenderInput[] = [
  { id: '1', username: 'alina.frames', fullName: 'Alina Moreno' },
  { id: '2', username: 'bob.builder', fullName: 'Bob Builder' },
  { id: '3', username: 'brandco', fullName: 'Brand Co' },
  { id: '4', username: 'nightform', fullName: 'Alex Mercer' },
  { id: '5', username: 'photon.bot', fullName: 'Photon Bot' },
  { id: '6', username: 'acme.studio', fullName: 'ACME Studio' },
];

async function main(): Promise<void> {
  const typeSafeKey = readKey('TYPESAFE_API_KEY', '.typesafe-key');
  const deepSeekKey = readKey('DEEPSEEK_API_KEY', '.deepseek-key');
  if (typeSafeKey === '' && deepSeekKey === '') {
    console.error('No keys: put TypeSafe and/or DeepSeek keys in .typesafe-key / .deepseek-key, or set TYPESAFE_API_KEY / DEEPSEEK_API_KEY.');
    process.exit(1);
  }

  const config = {
    ...DEFAULT_DEEPSEEK_CONFIG,
    provider: (typeSafeKey !== '' ? 'typesafe' : 'deepseek') as 'typesafe' | 'deepseek',
    fallbackToDeepSeek: deepSeekKey !== '',
    typesafeApiKey: typeSafeKey,
    typesafeBaseUrl: 'https://api.typesafe.ai',
    typesafeModel: 'jev-latest',
    mode: 'direct' as const,
    directBaseUrl: 'https://api.deepseek.com',
    apiKey: deepSeekKey,
    model: 'deepseek-chat',
    batchSize: 10,
    requestTimeoutMs: 45000,
    maxRetries: 1,
  };

  console.log('1) connectivity probe (primary + fallback)…');
  const connection = await testDeepSeekConnection(config);
  console.log(`   ok=${connection.ok} message=${connection.message}`);
  if (!connection.ok) {
    process.exit(1);
  }

  console.log('2) real classification through the app classifier (synthetic names only)…');
  const classifier = createGenderClassifier(config, {
    fetchImpl: fetch,
    storage: memoryStorage(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
  });
  const guesses = await classifier.classifyBatch(USERS);
  for (const guess of guesses) {
    const user = USERS.find(candidate => candidate.id === guess.id);
    console.log(
      `   ${guess.id} ${String(user?.fullName ?? '?')} -> ${guess.gender} (${guess.confidence}) ${guess.reason ?? ''}`,
    );
  }

  const ids = guesses.map(guess => guess.id).sort();
  const expected = USERS.map(user => user.id).sort();
  if (ids.join(',') !== expected.join(',')) {
    console.error('Classifier did not answer for every account.');
    process.exit(1);
  }
  const alina = guesses.find(guess => guess.id === '1');
  const bob = guesses.find(guess => guess.id === '2');
  if (alina?.gender !== 'female' || bob?.gender !== 'male') {
    console.error('Unexpected classification for the unambiguous fixture names.');
    process.exit(1);
  }
  console.log('REAL_CLASSIFIER_OK');
}

main().catch(error => {
  console.error('Real-API check failed:', error);
  process.exit(1);
});

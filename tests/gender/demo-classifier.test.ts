import { describe, expect, it } from 'vitest';
import { DEFAULT_DEEPSEEK_CONFIG } from '../../src/model/deepseek-config';
import {
  DEMO_GENDER_CLASSIFIER_MODEL,
  DEMO_GENDER_CLASSIFIER_VERSION,
  createDemoGenderClassifier,
} from '../../src/utils/gender-classifier';
import { GenderInput } from '../../src/model/gender';
import { networkGuard } from '../setup';

function user(username: string, fullName: string): GenderInput {
  return { id: `id-${username}`, username, fullName };
}

describe('demo gender classifier metadata and determinism', () => {
  it('is fully offline and reports stable version/source/model', () => {
    const classifier = createDemoGenderClassifier();
    expect(classifier.source).toBe('demo');
    expect(classifier.version).toBe('demo-names:v2');
    expect(classifier.model).toBe('demo-names:v2');
    expect(classifier.version).toBe(DEMO_GENDER_CLASSIFIER_VERSION);
    expect(classifier.model).toBe(DEMO_GENDER_CLASSIFIER_MODEL);
  });

  it('produces identical output for identical input on repeated runs', async () => {
    const users = [user('alina.frames', 'Alina Moreno'), user('nightform', 'Alex Mercer'), user('owen.v', 'Owen Voss')];
    const first = await createDemoGenderClassifier().classifyBatch(users);
    const second = await createDemoGenderClassifier().classifyBatch(users);
    expect(second).toEqual(first);
  });

  it('never touches the network', async () => {
    await createDemoGenderClassifier().classifyBatch([user('alina.frames', 'Alina Moreno')]);
    expect(networkGuard).not.toHaveBeenCalled();
  });
});

describe('demo gender classifier first-name heuristics', () => {
  it('recognizes conventional feminine given names as female', async () => {
    const entries = await createDemoGenderClassifier().classifyBatch([
      user('alina.frames', 'Alina Moreno'),
      user('priya.shah', 'Priya Shah'),
    ]);
    expect(entries.map(entry => entry.gender)).toEqual(['female', 'female']);
    expect(entries[0].confidence).toBeGreaterThanOrEqual(0.9);
    expect(entries[0].reason).toContain('feminine');
  });

  it('recognizes conventional masculine given names as male', async () => {
    const entries = await createDemoGenderClassifier().classifyBatch([
      user('elias.market', 'Elias Noor'),
      user('owen.voss', 'Owen Voss'),
    ]);
    expect(entries.map(entry => entry.gender)).toEqual(['male', 'male']);
    expect(entries[1].confidence).toBeGreaterThanOrEqual(0.9);
    expect(entries[1].reason).toContain('masculine');
  });

  it('reports gender-neutral names as ambiguous instead of guessing', async () => {
    const entries = await createDemoGenderClassifier().classifyBatch([
      user('nightform', 'Alex Mercer'),
      user('quiet.park', 'Jordan Blake'),
      user('zero.point', 'Riley Adams'),
    ]);
    for (const entry of entries) {
      expect(entry.gender).toBe('ambiguous');
      expect(entry.confidence).toBeLessThan(0.6);
      expect(entry.reason).toBeDefined();
    }
  });

  it('reports business/brand names as organization', async () => {
    const entries = await createDemoGenderClassifier().classifyBatch([
      user('glint.supply', 'Glint Supply Co.'),
      user('terra.works', 'Terra Works'),
      user('acme.studio', 'ACME Studio'),
    ]);
    expect(entries.map(entry => entry.gender)).toEqual(['organization', 'organization', 'organization']);
    expect(entries[0].reason).toContain('organization');
    expect(entries[0].confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('reports bot-like names as machine', async () => {
    const entries = await createDemoGenderClassifier().classifyBatch([
      user('photon.bot', 'Photon Bot'),
      user('scheduler.daily', 'Scheduler Daily'),
      user('daily_ai_digest', 'Daily AI Digest'),
    ]);
    expect(entries.map(entry => entry.gender)).toEqual(['machine', 'machine', 'machine']);
    expect(entries[0].reason).toContain('bot');
    expect(entries[1].confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects machine accounts before business words in the same name', async () => {
    const entries = await createDemoGenderClassifier().classifyBatch([user('daily_ai_digest', 'Daily AI Digest')]);
    // "daily" is also a business/org word, but the machine signal wins.
    expect(entries[0].gender).toBe('machine');
  });

  it('only treats display-name business words as organization signals', async () => {
    // A media-ish username token alone should not turn a personal display name
    // into an organization.
    const entries = await createDemoGenderClassifier().classifyBatch([user('studio.alina', 'Alina Moreno')]);
    expect(entries[0].gender).toBe('female');
  });

  it('uses username tokens when the display name is empty', async () => {
    const entries = await createDemoGenderClassifier().classifyBatch([
      user('alina.frames', ''),
      user('owen.voss', ''),
    ]);
    expect(entries.map(entry => entry.gender)).toEqual(['female', 'male']);
  });

  it('ignores username scaffolding such as official/real prefixes', async () => {
    const entries = await createDemoGenderClassifier().classifyBatch([
      user('real.alina.official', ''),
      user('the.owen.show', ''),
    ]);
    expect(entries.map(entry => entry.gender)).toEqual(['female', 'male']);
  });

  it('falls back to suffix heuristics with lower confidence', async () => {
    const entries = await createDemoGenderClassifier().classifyBatch([
      user('zoriana', 'Zoriana'),
      user('bruno', 'Bruno'),
    ]);
    expect(entries[0].gender).toBe('female');
    expect(entries[0].confidence).toBeLessThan(0.9);
    expect(entries[1].gender).toBe('male');
    expect(entries[1].confidence).toBeLessThan(0.9);
  });

  it('returns ambiguous for names it cannot classify', async () => {
    const entries = await createDemoGenderClassifier().classifyBatch([user('xyz987', 'Xyz Qwerty')]);
    expect(entries[0].gender).toBe('ambiguous');
    expect(entries[0].confidence).toBeLessThan(0.5);
    expect(entries[0].reason).toBeDefined();
  });

  it('returns ambiguous when there is no recognizable name at all', async () => {
    const entries = await createDemoGenderClassifier().classifyBatch([user('', '')]);
    expect(entries[0].gender).toBe('ambiguous');
    expect(entries[0].confidence).toBeLessThan(0.5);
  });

  it('keeps input order and answers exactly one entry per account', async () => {
    const entries = await createDemoGenderClassifier().classifyBatch([
      user('b', 'Owen'),
      user('a', 'Alina'),
      user('c', 'Zzyzx'),
    ]);
    expect(entries.map(entry => entry.id)).toEqual(['id-b', 'id-a', 'id-c']);
    expect(entries).toHaveLength(3);
  });

  it('honors explicit titles in display names', async () => {
    const entries = await createDemoGenderClassifier().classifyBatch([
      user('person1', 'Mrs Alina Moreno'),
      user('person2', 'Mr Owen Voss'),
    ]);
    expect(entries[0].gender).toBe('female');
    expect(entries[1].gender).toBe('male');
  });
});

describe('demo defaults stay aligned with the shared config', () => {
  it('can be dropped in wherever a GenderClassifier is expected', () => {
    const classifier = createDemoGenderClassifier();
    const config = DEFAULT_DEEPSEEK_CONFIG;
    expect(classifier.model).not.toBe(config.model);
    expect(classifier.model).not.toBe(config.typesafeModel);
    expect(typeof classifier.classifyBatch).toBe('function');
  });
});

/**
 * Photo-assisted classification: profile photos are described by the DeepSeek
 * vision model, then the cues are folded into Jev's main classification together
 * with the public username and display name. Jev must remain the decision-maker.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_DEEPSEEK_CONFIG, DeepSeekConfig } from '../../src/model/deepseek-config';
import { createGenderClassifier } from '../../src/utils/gender-classifier';
import { MemoryStorage } from './test-helpers';

interface RecordedCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function config(): DeepSeekConfig {
  return {
    ...DEFAULT_DEEPSEEK_CONFIG,
    provider: 'typesafe',
    fallbackToDeepSeek: true,
    includeProfilePhotos: true,
    visionModel: 'deepseek-flash',
    typesafeApiKey: 'apikey_test',
    typesafeBaseUrl: 'https://api.typesafe.ai',
    typesafeModel: 'jev-latest',
    mode: 'direct',
    directBaseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    model: 'deepseek-chat',
    batchSize: 10,
    maxRetries: 0,
  };
}

function typeSafeResponse(questions: Record<string, unknown>): Response {
  const answers: Record<string, unknown> = {};
  for (const key of Object.keys(questions)) {
    answers[key] = { type: 'choice', choice: 'male', confidence: 0.9, probabilities: { male: 0.9, female: 0.05 } };
  }
  return new Response(JSON.stringify({ model: 'jev-test', answers, usage: { input_tokens: 1, output_tokens: 1 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function chatContent(content: unknown): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

function makeFetch(options: { readonly failVision?: boolean; readonly calls: RecordedCall[] }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    options.calls.push({ url, body });
    if (url.includes('/v1/systemone')) {
      const questions = (body.questions ?? {}) as Record<string, unknown>;
      return typeSafeResponse(questions);
    }
    if (url.includes('/v1/chat/completions')) {
      if (options.failVision === true) {
        return new Response(JSON.stringify({ error: { message: 'vision unavailable' } }), { status: 500 });
      }
      const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>;
      const user = messages.find(message => message.role === 'user');
      const parts = Array.isArray(user?.content) ? (user.content as Array<Record<string, unknown>>) : [];
      const text = parts.map(part => (typeof part.text === 'string' ? part.text : '')).join(' ');
      const ids = Array.from(text.matchAll(/"account":"([^"]+)"/g)).map(match => match[1]);
      void ids;
      const results = [{ id: 'photo-1', cues: 'headshot of a person with a masculine presentation' }];
      return new Response(chatContent(JSON.stringify({ results })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

const photoUser = { id: 'photo-1', username: 'dave.builds', fullName: 'Dave Builder', profilePicUrl: 'https://cdn.example/photo.jpg' };
const textUser = { id: 'text-1', username: 'alina.frames', fullName: 'Alina Moreno' };

describe('photo-assisted classification keeps Jev in charge', () => {
  it('describes the photo with the vision model and sends the cues (plus names) to Jev', async () => {
    const calls: RecordedCall[] = [];
    const classifier = createGenderClassifier(config(), { fetchImpl: makeFetch({ calls }), storage: new MemoryStorage(), imageLoader: async () => 'data:image/jpeg;base64,AAAA' });
    const entries = await classifier.classifyBatch([photoUser, textUser]);

    const visionCall = calls.find(call => call.url.includes('/v1/chat/completions') && call.body.model === 'deepseek-flash');
    expect(visionCall).toBeDefined();
    const messages = visionCall?.body.messages as Array<{ role: string; content: unknown }>;
    const visionUser = messages.find(message => message.role === 'user');
    expect(Array.isArray(visionUser?.content)).toBe(true);
    const parts = visionUser?.content as Array<Record<string, unknown>>;
    const allText = parts.filter(part => part.type === 'text').map(part => String(part.text)).join(' ');
    expect(allText).toContain('dave.builds');
    expect(allText).toContain('Dave Builder');
    expect(parts.some(part => part.type === 'image_url')).toBe(true);
    const imagePart = parts.find(part => part.type === 'image_url') as { image_url?: { url?: string } } | undefined;
    expect(String(imagePart?.image_url?.url)).toMatch(/^data:image\//);

    const jevCall = calls.find(call => call.url.includes('/v1/systemone'));
    expect(jevCall).toBeDefined();
    const state = JSON.stringify(jevCall?.body.state);
    expect(state).toContain('dave.builds');
    expect(state).toContain('Dave Builder');
    expect(state).toContain('masculine presentation');
    expect(state).toContain('alina.frames');
    const questionText = JSON.stringify(jevCall?.body.questions);
    expect(questionText).toContain('photo_cues');
    expect(questionText.toLowerCase()).toContain('evidence');

    // The category decision and its provenance come from Jev (main), not from the vision model.
    expect(entries.map(entry => entry.source)).toEqual(['typesafe', 'typesafe']);
    expect(entries.every(entry => entry.model === 'jev-latest')).toBe(true);
  });

  it('classifies from the names with Jev when the vision pass fails', async () => {
    const calls: RecordedCall[] = [];
    const classifier = createGenderClassifier(config(), {
      fetchImpl: makeFetch({ calls, failVision: true }),
      storage: new MemoryStorage(),
      imageLoader: async () => 'data:image/jpeg;base64,AAAA',
    });
    const entries = await classifier.classifyBatch([photoUser, textUser]);
    expect(entries.map(entry => entry.source)).toEqual(['typesafe', 'typesafe']);
    const jevCall = calls.find(call => call.url.includes('/v1/systemone'));
    const state = JSON.stringify(jevCall?.body.state);
    expect(state).toContain('dave.builds');
    expect(state).not.toContain('masculine presentation');
  });

  it('does not call the vision model when photos are disabled', async () => {
    const calls: RecordedCall[] = [];
    const classifier = createGenderClassifier(
      { ...config(), includeProfilePhotos: false },
      { fetchImpl: makeFetch({ calls }), storage: new MemoryStorage(), imageLoader: async () => 'data:image/jpeg;base64,AAAA' },
    );
    await classifier.classifyBatch([photoUser, textUser]);
    expect(calls.filter(call => call.url.indexOf('/v1/chat/completions') !== -1)).toHaveLength(0);
  });
});

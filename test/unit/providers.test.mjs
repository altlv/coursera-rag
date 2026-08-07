import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  DEFAULT_PROVIDER,
  listAvailable,
  resolveProvider,
  createLlm,
  createEmbedder,
} from '../../server/llm-providers.js';

/*
 * Provider resolution, tested with injected fake environments so nothing here
 * needs a real key or touches the network.
 *
 * The behaviour that matters most: resolution must DEGRADE rather than throw. A
 * missing Gemini key should quietly fall back to OpenAI, not take the server
 * down on boot.
 */

const OPENAI_ONLY = { OPENAI_API_KEY: 'test-openai' };
const BOTH = { OPENAI_API_KEY: 'test-openai', GEMINI_API_KEY: 'test-gemini' };
const NONE = {};

describe('provider registry', () => {
  it('knows openai and gemini', () => {
    expect(Object.keys(PROVIDERS)).toEqual(expect.arrayContaining(['openai', 'gemini']));
  });

  it('defaults to openai, which is also the embedding provider', () => {
    // These must agree: the vector store is built in OpenAI's embedding space.
    expect(DEFAULT_PROVIDER).toBe('openai');
  });

  it('routes gemini through its OpenAI-compatibility layer', () => {
    // This is what lets one SDK serve both, with no extra dependency.
    expect(PROVIDERS.gemini.baseURL).toContain('generativelanguage.googleapis.com');
    expect(PROVIDERS.gemini.baseURL).toContain('/openai/');
    expect(PROVIDERS.openai.baseURL).toBeUndefined();
  });

  it('records that only OpenAI embeddings support truncated dimensions', () => {
    // The store relies on Matryoshka truncation to 512 dims.
    expect(PROVIDERS.openai.supportsEmbeddingDimensions).toBe(true);
    expect(PROVIDERS.gemini.supportsEmbeddingDimensions).toBe(false);
  });
});

describe('listAvailable', () => {
  it('lists only providers whose key is present', () => {
    expect(listAvailable(OPENAI_ONLY)).toEqual(['openai']);
    expect(listAvailable(BOTH)).toEqual(['openai', 'gemini']);
    expect(listAvailable(NONE)).toEqual([]);
  });

  it('does not list local providers unless explicitly enabled', () => {
    /*
     * Local servers are opt-in rather than probed. Listing one that is not running
     * would make fallback confusing: the provider would look available and then
     * fail on first use.
     */
    expect(listAvailable(OPENAI_ONLY)).not.toContain('lmstudio');
    expect(listAvailable(OPENAI_ONLY)).not.toContain('ollama');
  });

  it('ENABLE_LOCAL enables both local servers', () => {
    const available = listAvailable({ ...OPENAI_ONLY, ENABLE_LOCAL: 'true' });
    expect(available).toContain('lmstudio');
    expect(available).toContain('ollama');
  });

  it('still honours the older ENABLE_OLLAMA flag', () => {
    // An existing .env must keep working after the rename.
    expect(listAvailable({ ...OPENAI_ONLY, ENABLE_OLLAMA: 'true' })).toContain('ollama');
  });
});

describe('local providers', () => {
  it('are separate entries, because the two tools use different ports', () => {
    // One generic "local" entry would silently point at the wrong port, which is a
    // confusing failure to debug.
    expect(PROVIDERS.lmstudio.baseURL).toContain(':1234');
    expect(PROVIDERS.ollama.baseURL).toContain(':11434');
  });

  it('need no credential', () => {
    expect(PROVIDERS.lmstudio.keyless).toBe(true);
    expect(PROVIDERS.ollama.keyless).toBe(true);
  });

  it('offer no embeddings, so they cannot silently replace the store\'s model', () => {
    expect(PROVIDERS.lmstudio.embeddingModel).toBeNull();
    expect(PROVIDERS.ollama.embeddingModel).toBeNull();
  });

  it('can be created without any key', () => {
    const llm = createLlm({ provider: 'lmstudio', env: { ENABLE_LOCAL: 'true' } });
    expect(llm.provider).toBe('lmstudio');
    expect(typeof llm.complete).toBe('function');
  });
});

describe('resolveProvider', () => {
  it('honours an explicit request when its key exists', () => {
    const r = resolveProvider('gemini', BOTH);
    expect(r.name).toBe('gemini');
    expect(r.fellBack).toBe(false);
  });

  it('reads CHAT_PROVIDER when nothing is passed explicitly', () => {
    expect(resolveProvider(undefined, { ...BOTH, CHAT_PROVIDER: 'gemini' }).name).toBe('gemini');
  });

  it('is case-insensitive', () => {
    expect(resolveProvider('GEMINI', BOTH).name).toBe('gemini');
  });

  it('falls back rather than throwing when the requested key is missing', () => {
    // The important one: a missing Gemini key must not break the server.
    const r = resolveProvider('gemini', OPENAI_ONLY);
    expect(r.name).toBe('openai');
    expect(r.fellBack).toBe(true);
    expect(r.reason).toContain('GEMINI_API_KEY');
  });

  it('falls back on an unknown provider name', () => {
    const r = resolveProvider('llama-on-a-toaster', OPENAI_ONLY);
    expect(r.name).toBe('openai');
    expect(r.fellBack).toBe(true);
    expect(r.reason).toMatch(/unknown provider/i);
  });

  it('reports no provider when no key is set at all', () => {
    const r = resolveProvider('openai', NONE);
    expect(r.name).toBeNull();
    expect(r.reason).toMatch(/no provider key/i);
  });

  it('always explains its choice', () => {
    for (const env of [OPENAI_ONLY, BOTH, NONE]) {
      expect(typeof resolveProvider(undefined, env).reason).toBe('string');
    }
  });
});

describe('createLlm', () => {
  it('exposes the narrow shape generateAnswer expects', () => {
    const llm = createLlm({ env: OPENAI_ONLY });
    expect(typeof llm.complete).toBe('function');
    expect(llm.provider).toBe('openai');
    expect(llm.model).toBe(PROVIDERS.openai.defaultChatModel);
  });

  it('uses each provider default model', () => {
    expect(createLlm({ provider: 'gemini', env: BOTH }).model).toBe(
      PROVIDERS.gemini.defaultChatModel,
    );
  });

  it('lets CHAT_MODEL override the default', () => {
    const llm = createLlm({ env: { ...OPENAI_ONLY, CHAT_MODEL: 'gpt-4o' } });
    expect(llm.model).toBe('gpt-4o');
  });

  it('prefers an explicit model over CHAT_MODEL', () => {
    const llm = createLlm({ model: 'explicit', env: { ...OPENAI_ONLY, CHAT_MODEL: 'from-env' } });
    expect(llm.model).toBe('explicit');
  });

  it('throws only when no provider is usable at all', () => {
    expect(() => createLlm({ env: NONE })).toThrow(/no provider key/i);
  });

  it('carries the resolution so a fallback is visible downstream', () => {
    const llm = createLlm({ provider: 'gemini', env: OPENAI_ONLY });
    expect(llm.provider).toBe('openai');
    expect(llm.resolution.fellBack).toBe(true);
  });
});

describe('createEmbedder', () => {
  it('does NOT follow CHAT_PROVIDER', () => {
    /*
     * The decisive test. Embeddings must stay pinned to whatever built the vector
     * store; if this ever tracked CHAT_PROVIDER, switching the chat model would
     * silently start comparing query vectors against passage vectors from a
     * different embedding space - which yields plausible numbers that mean
     * nothing, with no error anywhere.
     */
    const embedder = createEmbedder({ env: { ...BOTH, CHAT_PROVIDER: 'gemini' } });
    expect(embedder.provider).toBe('openai');
    expect(embedder.model).toBe(PROVIDERS.openai.embeddingModel);
  });

  it('requires the key for the provider it was asked for', () => {
    expect(() => createEmbedder({ provider: 'gemini', env: OPENAI_ONLY })).toThrow(
      /GEMINI_API_KEY/,
    );
  });

  it('rejects an unknown provider', () => {
    expect(() => createEmbedder({ provider: 'nope', env: BOTH })).toThrow(/unknown/i);
  });
});

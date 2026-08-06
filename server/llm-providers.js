/*
 * Provider registry: swap which model writes the answers.
 *
 * A crucial asymmetry to understand before using this
 * ---------------------------------------------------
 * GENERATION is freely swappable. The answer writer receives passages that
 * retrieval already chose, so changing it changes only the prose. Retrieval,
 * scores, citations and the golden set all stay identical - which makes it a
 * clean A/B: same evidence, different writer.
 *
 * EMBEDDINGS are not. The vector store is 1,136 passages in OpenAI's
 * text-embedding-3-small 512-dimension space. A Gemini embedding of the same
 * text lands in a completely different space, and comparing across the two
 * produces plausible numbers that mean nothing. Switching the embedding provider
 * therefore requires rebuilding BOTH the store and the golden fixture, and
 * loadVectorStore() already refuses to mix them.
 *
 * So: CHAT_PROVIDER is a runtime switch. EMBEDDING_PROVIDER is a rebuild.
 *
 * Gemini is reached through its OpenAI-compatibility layer, so the same `openai`
 * SDK serves both and no extra dependency is needed. Verified: that endpoint
 * authenticates with a standard `Authorization: Bearer <key>` header.
 */

const { OpenAI } = require('openai');

/*
 * Every provider here speaks the OpenAI chat-completions protocol, so one SDK
 * serves all of them and adding one costs a table entry rather than a dependency.
 *
 * Model IDs are DEFAULTS, not guarantees. Provider model naming churns quickly,
 * so each is overridable per provider via its own env var (e.g. GROQ_MODEL) or
 * globally via CHAT_MODEL. If a name is rejected, the API error names the model,
 * which is the fastest way to find the current one.
 */
const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    modelEnvKey: 'OPENAI_MODEL',
    /** undefined means the SDK's own default host. */
    baseURL: undefined,
    defaultChatModel: 'gpt-4o-mini',
    embeddingModel: 'text-embedding-3-small',
    /** text-embedding-3-* support Matryoshka truncation via `dimensions`. */
    supportsEmbeddingDimensions: true,
  },
  gemini: {
    label: 'Google Gemini',
    envKey: 'GEMINI_API_KEY',
    modelEnvKey: 'GEMINI_MODEL',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultChatModel: 'gemini-2.0-flash',
    embeddingModel: 'text-embedding-004',
    supportsEmbeddingDimensions: false,
  },
  openrouter: {
    /*
     * One key, many models. The highest-leverage entry here: it fronts most other
     * providers, so it removes any need for separate Mistral / DeepSeek /
     * Together / Fireworks keys. Model IDs are namespaced, e.g.
     * "meta-llama/llama-3.3-70b-instruct" or "mistralai/mistral-small".
     */
    label: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    modelEnvKey: 'OPENROUTER_MODEL',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultChatModel: 'meta-llama/llama-3.3-70b-instruct',
    embeddingModel: null,
    supportsEmbeddingDimensions: false,
  },
  groq: {
    /*
     * Note: Groq (this) is a different company from Grok (xAI, below). Very easy
     * to confuse. Groq serves open-weight models extremely fast, which makes it
     * the useful contrast for both latency and instruction-following.
     */
    label: 'Groq',
    envKey: 'GROQ_API_KEY',
    modelEnvKey: 'GROQ_MODEL',
    baseURL: 'https://api.groq.com/openai/v1',
    defaultChatModel: 'llama-3.3-70b-versatile',
    embeddingModel: null,
    supportsEmbeddingDimensions: false,
  },
  xai: {
    label: 'xAI (Grok)',
    envKey: 'XAI_API_KEY',
    modelEnvKey: 'XAI_MODEL',
    baseURL: 'https://api.x.ai/v1',
    defaultChatModel: 'grok-3-mini',
    embeddingModel: null,
    supportsEmbeddingDimensions: false,
  },
  ollama: {
    /*
     * Local models, no key and no cost. Included because it demonstrates that
     * none of this pipeline requires a cloud provider - and because a small local
     * model is the honest test of how much the grounding instruction is doing.
     *
     * Availability is decided by the server running, not by a key, so `envKey`
     * points at an optional override of the host.
     */
    label: 'Ollama (local)',
    envKey: 'OLLAMA_BASE_URL',
    modelEnvKey: 'OLLAMA_MODEL',
    baseURL: 'http://localhost:11434/v1',
    defaultChatModel: 'llama3.2',
    embeddingModel: null,
    supportsEmbeddingDimensions: false,
    /** Needs no credential; the SDK still wants a non-empty string. */
    keyless: true,
  },
};

const DEFAULT_PROVIDER = 'openai';

/**
 * Provider names usable right now.
 *
 * Keyless providers (Ollama) are opt-in via ENABLE_OLLAMA rather than assumed:
 * probing localhost on every call would be slow, and silently listing a provider
 * that is not running would make fallback behaviour confusing.
 */
function listAvailable(env = process.env) {
  return Object.entries(PROVIDERS)
    .filter(([name, config]) => {
      if (config.keyless) return env.ENABLE_OLLAMA === 'true' || Boolean(env[config.envKey]);
      return Boolean(env[config.envKey]);
    })
    .map(([name]) => name);
}

/** Model for a provider: explicit > provider-specific env > CHAT_MODEL > default. */
function resolveModel(name, explicit, env = process.env) {
  const config = PROVIDERS[name];
  return explicit || env[config.modelEnvKey] || env.CHAT_MODEL || config.defaultChatModel;
}

/**
 * Resolve which provider to use, and say plainly why.
 *
 * Falls back rather than throwing, so a missing Gemini key degrades to OpenAI
 * instead of taking the whole server down.
 */
function resolveProvider(requested, env = process.env) {
  const available = listAvailable(env);
  const wanted = (requested || env.CHAT_PROVIDER || DEFAULT_PROVIDER).toLowerCase();

  if (!PROVIDERS[wanted]) {
    return {
      name: available[0] || null,
      reason: `unknown provider "${wanted}"; known: ${Object.keys(PROVIDERS).join(', ')}`,
      fellBack: true,
    };
  }

  if (available.includes(wanted)) {
    return { name: wanted, reason: 'requested and key present', fellBack: false };
  }

  if (available.length > 0) {
    return {
      name: available[0],
      reason: `${PROVIDERS[wanted].envKey} is not set; using ${available[0]} instead`,
      fellBack: true,
    };
  }

  return { name: null, reason: 'no provider key is set', fellBack: true };
}

/**
 * Build an `llm` for generateAnswer: any object with
 * `complete({ system, user }) -> Promise<string>`.
 *
 * That narrow shape is what keeps generateAnswer testable with a fake and
 * provider-agnostic at the same time.
 */
function createLlm({ provider, model, temperature = 0.2, env = process.env } = {}) {
  const resolved = resolveProvider(provider, env);
  if (!resolved.name) {
    throw new Error(`Cannot create an LLM: ${resolved.reason}`);
  }

  const config = PROVIDERS[resolved.name];
  const client = new OpenAI({
    // Keyless providers still need a non-empty string to satisfy the SDK.
    apiKey: config.keyless ? env[config.envKey] || 'ollama' : env[config.envKey],
    baseURL: config.keyless ? env[config.envKey] || config.baseURL : config.baseURL,
  });

  const chatModel = resolveModel(resolved.name, model, env);

  return {
    provider: resolved.name,
    providerLabel: config.label,
    model: chatModel,
    resolution: resolved,
    lastUsage: undefined,

    async complete({ system, user }) {
      const response = await client.chat.completions.create({
        model: chatModel,
        temperature,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });

      this.lastUsage = response.usage;
      return response.choices?.[0]?.message?.content || '';
    },
  };
}

/**
 * Client for embeddings.
 *
 * Deliberately separate from createLlm. The embedding provider must match
 * whatever built the vector store, so it is NOT expected to follow
 * CHAT_PROVIDER - conflating them is how you end up comparing two unrelated
 * vector spaces.
 */
function createEmbedder({ provider = DEFAULT_PROVIDER, env = process.env } = {}) {
  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown embedding provider "${provider}"`);

  if (!config.embeddingModel) {
    throw new Error(
      `${config.label} does not offer embeddings here - it is a chat-only provider. ` +
        `Embeddings must come from whatever built the vector store.`,
    );
  }

  const apiKey = env[config.envKey];
  if (!apiKey) throw new Error(`${config.envKey} is not set`);

  const client = new OpenAI({ apiKey, baseURL: config.baseURL });

  return {
    provider,
    model: config.embeddingModel,
    supportsDimensions: config.supportsEmbeddingDimensions,
    client,
  };
}

module.exports = {
  PROVIDERS,
  DEFAULT_PROVIDER,
  listAvailable,
  resolveModel,
  resolveProvider,
  createLlm,
  createEmbedder,
};

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
const { classifyProviderError } = require('./provider-health');

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
  /*
   * Local model servers. No key, no cost, no rate limits, works offline.
   *
   * Two entries rather than one generic "local", because the two tools listen on
   * different ports and picking the wrong one is a confusing failure. Both speak
   * the same OpenAI protocol.
   *
   * Worth having alongside the cloud providers for three reasons: it proves this
   * pipeline needs no cloud provider at all; it is the only option nobody can
   * withdraw, unlike a free tier; and a small local model is the honest test of
   * how much work the grounding instruction is really doing.
   *
   * Availability is decided by the server running, not by a key, so these are
   * opt-in via ENABLE_LOCAL rather than probed on every request.
   */
  lmstudio: {
    label: 'LM Studio (local)',
    envKey: 'LMSTUDIO_BASE_URL',
    modelEnvKey: 'LMSTUDIO_MODEL',
    baseURL: 'http://localhost:1234/v1',
    // LM Studio serves whatever is loaded; "local-model" is accepted as an alias.
    defaultChatModel: 'local-model',
    embeddingModel: null,
    supportsEmbeddingDimensions: false,
    keyless: true,
  },
  ollama: {
    label: 'Ollama (local)',
    envKey: 'OLLAMA_BASE_URL',
    modelEnvKey: 'OLLAMA_MODEL',
    baseURL: 'http://localhost:11434/v1',
    defaultChatModel: 'qwen2.5-coder:7b',
    embeddingModel: null,
    supportsEmbeddingDimensions: false,
    keyless: true,
  },
};

const DEFAULT_PROVIDER = 'openai';

/*
 * Bounds on a single generation call.
 *
 * Without a timeout a hung provider hangs the whole request indefinitely - there
 * is no upstream deadline to save us. 30 seconds is generous for a ~1,300-token
 * prompt while still failing fast enough to retry inside a request.
 *
 * Retries apply only to TRANSIENT failures, which provider-health already
 * classifies. Retrying a permanent failure (no credits, revoked key) just burns
 * time to reach the same conclusion, so those fail immediately.
 */
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

/**
 * Provider names usable right now.
 *
 * Keyless providers (Ollama) are opt-in via ENABLE_OLLAMA rather than assumed:
 * probing localhost on every call would be slow, and silently listing a provider
 * that is not running would make fallback behaviour confusing.
 */
function listAvailable(env = process.env) {
  return Object.entries(PROVIDERS)
    .filter(([, config]) => {
      /*
       * Keyless providers are opt-in. Probing localhost on every call would be
       * slow, and listing a local server that is not running would make the
       * fallback behaviour confusing - a provider would appear available and then
       * fail on use.
       *
       * ENABLE_OLLAMA is still honoured so an existing .env keeps working.
       */
      if (config.keyless) {
        return (
          env.ENABLE_LOCAL === 'true' ||
          env.ENABLE_OLLAMA === 'true' ||
          Boolean(env[config.envKey])
        );
      }
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
function createLlm({
  provider,
  model,
  temperature = 0.2,
  env = process.env,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxAttempts = MAX_ATTEMPTS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  /*
   * Injectable transport, so tests can exercise the real retry and timeout logic
   * against a scripted client. Without this the only way to test the loop would be
   * to re-implement it in the test - which tests the copy, not the code.
   */
  client: injectedClient,
} = {}) {
  const resolved = resolveProvider(provider, env);
  if (!resolved.name) {
    throw new Error(`Cannot create an LLM: ${resolved.reason}`);
  }

  const config = PROVIDERS[resolved.name];
  const client =
    injectedClient ||
    new OpenAI({
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

    /** Attempts actually made on the last call, for logging and tests. */
    lastAttempts: 0,

    async complete({ system, user }) {
      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];

      let lastError;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        this.lastAttempts = attempt;

        try {
          const response = await client.chat.completions.create(
            { model: chatModel, temperature, messages },
            // The SDK converts this into an abort, so a hung provider cannot
            // hold the request open indefinitely.
            { timeout: timeoutMs },
          );

          this.lastUsage = response.usage;
          return response.choices?.[0]?.message?.content || '';
        } catch (error) {
          lastError = error;

          /*
           * Only retry what can actually succeed on a second try. A permanent
           * failure - no credits, revoked key, nonexistent model - will fail
           * identically three times, so retrying only delays the error.
           */
          const { permanent } = classifyProviderError(error);
          if (permanent || attempt === maxAttempts) throw error;

          // Exponential backoff: 500ms, then 1000ms. Deliberately no jitter -
          // this is a single-user prototype, not a fleet stampeding one endpoint.
          await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        }
      }

      throw lastError;
    },

    /**
     * The same call, delivered incrementally.
     *
     * Deliberately NOT retried. `complete` can retry safely because nothing has
     * been shown to the user yet; once deltas have been forwarded, a retry would
     * either duplicate text or silently replace what was already on screen. A
     * stream that breaks mid-answer surfaces as an error and the user re-asks -
     * which is honest, where a half-answer stitched to a second attempt is not.
     *
     * Usage is only available on the final chunk, and only when explicitly asked
     * for, so `stream_options` is set - otherwise the spend ledger would silently
     * record nothing for every streamed answer.
     */
    async *stream({ system, user }) {
      this.lastAttempts = 1;
      const response = await client.chat.completions.create(
        {
          model: chatModel,
          temperature,
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        { timeout: timeoutMs },
      );

      for await (const part of response) {
        // The usage-bearing chunk has no choices, so this must not assume one.
        if (part.usage) this.lastUsage = part.usage;
        const delta = part.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
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
  REQUEST_TIMEOUT_MS,
  MAX_ATTEMPTS,
  listAvailable,
  resolveModel,
  resolveProvider,
  createLlm,
  createEmbedder,
};

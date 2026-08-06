/*
 * Ask each configured provider which models it actually offers.
 *
 *   npm run list-models
 *   npm run list-models -- --all      (don't filter to likely chat models)
 *
 * Why this exists: the default model IDs in server/llm-providers.js are educated
 * guesses, and provider model naming churns constantly. Rather than discovering a
 * stale default through a confusing 404 mid-conversation, ask the source.
 *
 * Every provider here exposes the OpenAI-compatible GET /models, so one code path
 * covers all of them. Costs nothing - listing models is not a billed inference
 * call.
 */

const dotenv = require('dotenv');
const { PROVIDERS, listAvailable, resolveModel } = require('../server/llm-providers');

dotenv.config();

const SHOW_ALL = process.argv.includes('--all');

/*
 * Model lists are long and full of non-chat entries (embeddings, image, audio,
 * moderation, TTS). Filter to what could plausibly answer a question, unless
 * --all is passed.
 */
const NOT_CHAT = /embed|whisper|tts|audio|image|dall-e|moderation|rerank|guard|vision-only/i;

async function listFor(name) {
  const config = PROVIDERS[name];
  const apiKey = process.env[config.envKey] || (config.keyless ? 'ollama' : null);
  const baseURL = config.keyless
    ? process.env[config.envKey] || config.baseURL
    : config.baseURL || 'https://api.openai.com/v1';

  const response = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} - ${body.slice(0, 160)}`);
  }

  const payload = await response.json();
  const models = (payload.data || payload.models || [])
    .map((m) => m.id || m.name)
    .filter(Boolean)
    .sort();

  return SHOW_ALL ? models : models.filter((id) => !NOT_CHAT.test(id));
}

async function run() {
  const available = listAvailable();

  if (available.length === 0) {
    console.error('No provider keys found in .env. Expected any of:');
    for (const [name, config] of Object.entries(PROVIDERS)) {
      console.error(`  ${config.envKey.padEnd(22)} -> ${name}`);
    }
    process.exit(1);
  }

  console.log(`Configured providers: ${available.join(', ')}\n`);

  for (const name of available) {
    const config = PROVIDERS[name];
    const configured = resolveModel(name, undefined, process.env);

    console.log('='.repeat(70));
    console.log(`${config.label}  (${name})`);
    console.log(`  configured model: ${configured}`);
    console.log('='.repeat(70));

    try {
      const models = await listFor(name);

      if (models.length === 0) {
        console.log('  (provider returned no models)\n');
        continue;
      }

      // The check that matters: is the configured default actually real?
      const exists = models.includes(configured);
      console.log(
        `  configured model is ${exists ? 'VALID' : 'NOT in the list - override it in .env'}`,
      );

      console.log(`  ${models.length} model(s)${SHOW_ALL ? '' : ' (chat-capable, filtered)'}:`);
      for (const id of models.slice(0, 40)) {
        console.log(`    ${id === configured ? '*' : ' '} ${id}`);
      }
      if (models.length > 40) console.log(`    ... and ${models.length - 40} more (--all to widen)`);
      console.log('');
    } catch (error) {
      console.log(`  could not list models: ${error.message}\n`);
    }
  }

  console.log('Set a specific model with the provider env var, e.g.:');
  console.log('  XAI_MODEL=grok-4');
  console.log('  OPENROUTER_MODEL=mistralai/mistral-small');
  console.log('  GEMINI_MODEL=gemini-2.5-flash');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

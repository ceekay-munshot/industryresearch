/**
 * scripts/test-bedrock.mjs — minimal Bedrock connectivity check.
 *
 * Confirms the Bedrock API key + region + model id are wired correctly BEFORE
 * running the real research pipeline. Prints the reply and exits 0 on success;
 * prints the full error (status + body) and exits 1 on failure.
 */
import { callClaude, llmConfig } from '../lib/llm.mjs';

const cfg = llmConfig();
console.log(`[test-bedrock] region=${cfg.region} model=${cfg.model_id}`);
console.log(`[test-bedrock] endpoint=${cfg.endpoint}`);

try {
  const reply = await callClaude({
    system: 'Reply with exactly: OK',
    user: 'Say OK.',
    max_tokens: 16,
  });
  console.log(`[test-bedrock] reply: ${JSON.stringify(reply)}`);
  console.log('[test-bedrock] SUCCESS');
  process.exit(0);
} catch (err) {
  console.error('[test-bedrock] FAILED');
  console.error(err && err.stack ? err.stack : String(err));
  console.error('\nLikely fixes (set as GitHub secrets):');
  console.error('  1. BEDROCK_REGION  -> your key\'s region');
  console.error('  2. BEDROCK_MODEL_ID -> e.g. "us.anthropic.claude-sonnet-5", "anthropic.claude-sonnet-5",');
  console.error('                          "us.anthropic.claude-opus-4-8", or "anthropic.claude-opus-4-8"');
  process.exit(1);
}

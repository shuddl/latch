// The single seam for build-time AI (CLAUDE.md §2.2: LLMs at build/heal time only,
// never in the per-transaction runtime). Everything that needs the model depends on
// this interface, so the spec ingestor, map generator, and heal patcher are testable
// with a fake client — and the Verification Engine, not the model, remains the gate.

import { LatchError } from './errors';

export interface LlmExtractOptions {
  system: string;
  user: string;
  maxTokens?: number;
}

/** Returns a parsed-but-unvalidated JSON value; the caller validates with Zod. */
export interface LlmClient {
  extractJson(opts: LlmExtractOptions): Promise<unknown>;
}

/** Pull the first JSON object/array out of a model response, tolerating code fences. */
export function parseJsonLoose(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.search(/[[{]/);
  if (start < 0) throw new LatchError('INTERNAL', 'Model did not return JSON');
  // Walk to the matching closing bracket so trailing prose is ignored.
  const open = body[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch (e) {
          throw new LatchError('INTERNAL', `Model returned invalid JSON: ${String(e)}`);
        }
      }
    }
  }
  throw new LatchError('INTERNAL', 'Model returned truncated JSON');
}

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

// Build/heal-time only. Uses the Messages API over fetch (no SDK → Workers-safe).
export function createAnthropicClient(cfg: AnthropicConfig): LlmClient {
  const model = cfg.model ?? 'claude-sonnet-4-6';
  const baseUrl = cfg.baseUrl ?? 'https://api.anthropic.com';
  const doFetch = cfg.fetchImpl ?? fetch;
  return {
    async extractJson({ system, user, maxTokens = 4096 }: LlmExtractOptions): Promise<unknown> {
      const res = await doFetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: `${system}\n\nRespond with ONLY a single JSON value — no prose, no code fences.`,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (!res.ok) {
        throw new LatchError('INTERNAL', `Anthropic API error ${res.status}`, { status: 502 });
      }
      const data = (await res.json()) as { content?: { text?: string }[] };
      const text = data.content?.map((c) => c.text ?? '').join('') ?? '';
      return parseJsonLoose(text);
    },
  };
}

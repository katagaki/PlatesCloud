export const GRANITE_MODEL = "@cf/ibm-granite/granite-4.0-h-micro";
export const MAX_OUTPUT_TOKENS = 1400;
const MAX_MESSAGES = 16;
const MAX_CHARACTERS = 24_000;
const ROLES = new Set(["system", "user", "assistant"]);

export interface Chat {
  messages: { role: string; content: string }[];
  max_tokens: number;
  temperature: number;
  stream: boolean;
}

export function parseChat(body: unknown): Chat | string {
  if (typeof body !== "object" || body === null) return "body must be an object";
  const { messages, max_tokens, temperature, stream } = body as { [key: string]: unknown };
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) return "messages must hold 1 to 16 entries";
  let characters = 0;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) return "each message must be an object";
    const { role, content } = message as { [key: string]: unknown };
    if (typeof role !== "string" || !ROLES.has(role) || typeof content !== "string") return "each message needs a role and content";
    characters += content.length;
  }
  if (characters > MAX_CHARACTERS) return "messages are too long";
  const tokens = max_tokens === undefined ? MAX_OUTPUT_TOKENS : max_tokens;
  if (!Number.isInteger(tokens) || (tokens as number) < 1 || (tokens as number) > MAX_OUTPUT_TOKENS) return "max_tokens must be 1 to 1400";
  const heat = temperature === undefined ? 0.7 : temperature;
  if (typeof heat !== "number" || heat < 0 || heat > 1.5) return "temperature must be 0 to 1.5";
  return {
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    max_tokens: tokens as number,
    temperature: heat,
    stream: stream === true,
  };
}

function text(part: unknown): string {
  if (typeof part !== "object" || part === null) return "";
  const value = part as { response?: unknown; choices?: { delta?: { content?: unknown }; message?: { content?: unknown } }[] };
  if (typeof value.response === "string") return value.response;
  const choice = value.choices?.[0];
  const content = choice?.delta?.content ?? choice?.message?.content;
  return typeof content === "string" ? content : "";
}

export function completion(result: unknown): object {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: GRANITE_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: text(result) }, finish_reason: "stop" }],
  };
}

export function completionStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  const chunk = (delta: object, finish: string | null) =>
    encoder.encode(`data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created, model: GRANITE_MODEL,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);

  function lines(controller: TransformStreamDefaultController<Uint8Array>, final: boolean) {
    const parts = buffer.split("\n");
    buffer = final ? "" : parts.pop() ?? "";
    for (const line of parts) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const content = text(JSON.parse(payload));
        if (content) controller.enqueue(chunk({ content }, null));
      } catch {
        continue;
      }
    }
  }

  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      controller.enqueue(chunk({ role: "assistant", content: "" }, null));
    },
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      lines(controller, false);
    },
    flush(controller) {
      buffer += decoder.decode();
      lines(controller, true);
      controller.enqueue(chunk({}, "stop"));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  }));
}

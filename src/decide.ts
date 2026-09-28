export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
const JEV_TIMEOUT_MS = 20_000;

export interface Idea {
  title: string;
  summary: string;
}

export interface Decision {
  requestId: string;
  request: string;
  ingredients: string[];
  tools: string[];
  ideas: Idea[];
}

export interface Pick {
  index: number;
  confidence: number;
  probabilities: number[];
}

function strings(value: unknown, most: number, longest: number): string[] | null {
  if (!Array.isArray(value) || value.length > most) return null;
  return value.every((item) => typeof item === "string" && item.length <= longest) ? value : null;
}

export function parseDecision(body: unknown): Decision | string {
  if (typeof body !== "object" || body === null) return "body must be an object";
  const { requestId, request, ingredients, tools, ideas } = body as { [key: string]: unknown };
  if (typeof requestId !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(requestId)) return "requestId must be 1 to 64 letters, digits, or dashes";
  if (typeof request !== "string" || request.length === 0 || request.length > 2000) return "request must be 1 to 2000 characters";
  const picked = strings(ingredients ?? [], 80, 120);
  const kit = strings(tools ?? [], 40, 120);
  if (!picked || !kit) return "ingredients and tools must be short lists of strings";
  if (!Array.isArray(ideas) || ideas.length < 2 || ideas.length > 8) return "ideas must hold 2 to 8 entries";
  const parsed: Idea[] = [];
  for (const idea of ideas) {
    if (typeof idea !== "object" || idea === null) return "each idea must be an object";
    const { title, summary } = idea as { [key: string]: unknown };
    if (typeof title !== "string" || title.length === 0 || title.length > 200) return "each idea needs a title";
    if (summary !== undefined && (typeof summary !== "string" || summary.length > 1000)) return "summaries must be under 1000 characters";
    parsed.push({ title, summary: (summary as string | undefined) ?? "" });
  }
  return { requestId, request, ingredients: picked, tools: kit, ideas: parsed };
}

export function jevRequest(decision: Decision): object {
  const keys = decision.ideas.map((_, index) => `idea_${index + 1}`);
  return {
    model: JEV_MODEL,
    state: {
      request: decision.request,
      ingredients: decision.ingredients,
      tools: decision.tools,
      ideas: Object.fromEntries(decision.ideas.map((idea, index) => [keys[index], idea])),
    },
    questions: {
      pick: {
        type: "choice",
        instructions: "Pick the idea that best fits the cook's request and the ingredients and tools they have.",
        criteria: Object.fromEntries(decision.ideas.map((idea, index) => [keys[index], idea.title])),
      },
    },
  };
}

export async function askJev(decision: Decision, apiKey: string): Promise<Pick> {
  const response = await fetch(JEV_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(jevRequest(decision)),
    signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`jev returned ${response.status}`);
  const body = (await response.json()) as {
    answers?: { pick?: { choice?: unknown; confidence?: unknown; probabilities?: { [key: string]: unknown } } };
  };
  const answer = body.answers?.pick;
  const match = typeof answer?.choice === "string" ? /^idea_(\d+)$/.exec(answer.choice) : null;
  const index = match ? Number(match[1]) - 1 : -1;
  if (index < 0 || index >= decision.ideas.length) throw new Error("jev picked no idea");
  return {
    index,
    confidence: typeof answer?.confidence === "number" ? answer.confidence : 0,
    probabilities: decision.ideas.map((_, i) => {
      const value = answer?.probabilities?.[`idea_${i + 1}`];
      return typeof value === "number" ? value : 0;
    }),
  };
}

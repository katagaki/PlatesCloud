import { JEV_MODEL, JEV_URL } from "./decide";

const JEV_TIMEOUT_MS = 10_000;

const QUESTION =
  "Can `ingredient` be seen on top of the finished dish as it is served, as pieces, flecks, or a sprinkle that a person would notice?";

export interface Step {
  title: string;
  points: string[];
}

export interface Toppings {
  dish: string;
  steps: Step[];
  ingredients: string[];
}

function text(value: unknown, longest: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= longest;
}

export function parseToppings(body: unknown): Toppings | string {
  if (typeof body !== "object" || body === null) return "body must be an object";
  const { dish, steps, ingredients } = body as { [key: string]: unknown };
  if (!text(dish, 200)) return "dish must be 1 to 200 characters";
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 30) return "steps must hold 1 to 30 entries";
  const parsed: Step[] = [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null) return "each step must be an object";
    const { title, points } = step as { [key: string]: unknown };
    if (typeof title !== "string" || title.length > 200) return "each step needs a title under 200 characters";
    if (!Array.isArray(points) || points.length > 12 || !points.every((point) => text(point, 600))) return "each step needs up to 12 points";
    parsed.push({ title, points });
  }
  if (!Array.isArray(ingredients) || ingredients.length === 0 || ingredients.length > 30 || !ingredients.every((item) => text(item, 300))) {
    return "ingredients must hold 1 to 30 lines";
  }
  return { dish, steps: parsed, ingredients };
}

export function jevToppingsRequest(toppings: Toppings): object {
  return {
    model: JEV_MODEL,
    state: { dish: toppings.dish, method: toppings.steps.map(({ title, points }) => ({ step: title, points })) },
    questions: Object.fromEntries(
      toppings.ingredients.map((ingredient, index) => [`line_${index + 1}`, { type: "noul", instructions: { question: QUESTION, ingredient } }]),
    ),
  };
}

export async function askToppings(toppings: Toppings, apiKey: string): Promise<number[]> {
  const response = await fetch(JEV_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(jevToppingsRequest(toppings)),
    signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`jev returned ${response.status}`);
  const body = (await response.json()) as { answers?: { [key: string]: { noul?: unknown } } };
  return toppings.ingredients.map((_, index) => {
    const value = body.answers?.[`line_${index + 1}`]?.noul;
    if (typeof value !== "number") throw new Error("jev left a line unanswered");
    return value;
  });
}

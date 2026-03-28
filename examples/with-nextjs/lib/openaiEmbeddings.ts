const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

export const OPENAI_EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

export const OPENAI_EMBEDDING_DIMENSIONS = Number(process.env.QDRANT_VECTOR_SIZE || 1536);

export async function embedTextWithOpenAI(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Cannot embed empty text");
  }

  const response = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_EMBEDDING_MODEL,
      input: trimmed,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `OpenAI embedding request failed (${response.status}): ${details || response.statusText}`,
    );
  }

  const data = (await response.json().catch(() => null)) as
    | { data?: Array<{ embedding?: number[] }> }
    | null;
  const embedding = data?.data?.[0]?.embedding;

  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("OpenAI embedding response did not include an embedding vector");
  }

  return embedding;
}

import { searchMemoryByVector, searchMemoryByText, type MemorySearchResult } from "../db/memory.ts";

const RRF_K = 60;

// Common English stop words to filter out during keyword extraction
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "he",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "that",
  "the",
  "to",
  "was",
  "will",
  "with",
  "this",
  "about",
  "what",
  "when",
  "where",
  "who",
  "how",
  "thing",
]);

/**
 * Extract meaningful keywords from a conversational query.
 * Removes stop words and keeps words longer than 2 characters.
 */
function extractKeywords(query: string): string {
  const words = query.toLowerCase().match(/\b\w+\b/g) || [];
  const keywords = words.filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  return keywords.join(" ") || query;
}

/**
 * Text-only search fallback when embeddings are unavailable.
 * Uses keyword extraction and returns results with normalized scores.
 */
export async function textOnlySearch(
  query: string,
  limit: number = 10,
): Promise<MemorySearchResult[]> {
  const keywords = extractKeywords(query);
  const results = await searchMemoryByText(keywords, limit);

  // Normalize scores to 0-1 range based on rank
  return results.map((result, rank) => ({
    ...result,
    score: 1 / (RRF_K + rank + 1),
  }));
}

/**
 * Hybrid search combining vector similarity and full-text search.
 * Uses Reciprocal Rank Fusion (RRF) to merge results.
 */
export async function hybridSearch(
  query: string,
  embedding: number[],
  limit: number = 10,
): Promise<MemorySearchResult[]> {
  // Run both searches in parallel
  const [vectorResults, textResults] = await Promise.all([
    searchMemoryByVector(embedding, limit * 2),
    searchMemoryByText(query, limit * 2),
  ]);

  // Build RRF scores
  const scoreMap = new Map<string, { score: number; result: MemorySearchResult }>();

  // Score vector results by rank
  for (let rank = 0; rank < vectorResults.length; rank++) {
    const result = vectorResults[rank];
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = scoreMap.get(result.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(result.id, { score: rrfScore, result });
    }
  }

  // Score text results by rank
  for (let rank = 0; rank < textResults.length; rank++) {
    const result = textResults[rank];
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = scoreMap.get(result.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(result.id, { score: rrfScore, result });
    }
  }

  // Sort by combined score and return top results
  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, result }) => ({ ...result, score }));
}

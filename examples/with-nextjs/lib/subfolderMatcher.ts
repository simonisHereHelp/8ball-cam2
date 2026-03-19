export interface MatchableSubfolder {
  topic: string;
  folderId?: string;
  keywords?: string[];
  excluded_keywords?: string[];
  description?: string;
}

const normalizeComparable = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const includesKeyword = (summary: string, keyword: string) =>
  summary.includes(normalizeComparable(keyword));

const keywordWeight = (keyword: string) => {
  const normalized = normalizeComparable(keyword);
  if (!normalized) return 0;
  if (/[\u4e00-\u9fff]/u.test(normalized) || normalized.includes(" ")) return 6;
  if (normalized.length >= 8) return 5;
  if (normalized.length >= 5) return 4;
  return 2;
};

export const scoreSubfolderMatch = (
  summary: string,
  subfolder: MatchableSubfolder,
): number => {
  const normalizedSummary = normalizeComparable(summary);
  if (!normalizedSummary) return 0;

  let score = 0;
  let positiveHits = 0;

  for (const keyword of subfolder.keywords || []) {
    if (includesKeyword(normalizedSummary, keyword)) {
      positiveHits += 1;
      score += keywordWeight(keyword);
    }
  }

  for (const excluded of subfolder.excluded_keywords || []) {
    if (includesKeyword(normalizedSummary, excluded)) {
      score -= 20;
    }
  }

  if (positiveHits >= 2) score += 6;
  if (includesKeyword(normalizedSummary, subfolder.topic)) score += 8;

  return score;
};

export const findBestSubfolderMatch = <T extends MatchableSubfolder>(
  summary: string,
  subfolders: T[],
): T | null => {
  if (!summary.trim() || !subfolders.length) return null;

  let bestMatch: T | null = null;
  let bestScore = 0;

  for (const subfolder of subfolders) {
    const score = scoreSubfolderMatch(summary, subfolder);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = subfolder;
    }
  }

  return bestScore >= 6 ? bestMatch : null;
};

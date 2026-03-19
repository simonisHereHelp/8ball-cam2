import type { IssuerCanonEntry } from "@/types/issuerCanon";

const normalizeComparable = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");

const extractIssuerLine = (summary: string): string | null => {
  const match = summary.match(/^\s*(?:單位|单位|issuer)\s*[:：]\s*(.+?)\s*$/imu);
  return match?.[1]?.trim() || null;
};

const scoreLabelMatch = ({
  label,
  issuerLine,
  normalizedSummary,
  isMaster,
}: {
  label: string;
  issuerLine: string | null;
  normalizedSummary: string;
  isMaster: boolean;
}) => {
  const normalizedLabel = normalizeComparable(label);
  if (!normalizedLabel) return 0;

  const normalizedIssuer = issuerLine ? normalizeComparable(issuerLine) : "";
  let score = 0;

  if (normalizedIssuer) {
    if (normalizedIssuer === normalizedLabel) {
      score += 120;
    } else if (
      normalizedIssuer.length >= 4 &&
      (normalizedIssuer.includes(normalizedLabel) || normalizedLabel.includes(normalizedIssuer))
    ) {
      score += 80;
    }
  }

  if (normalizedSummary.includes(normalizedLabel)) {
    score += Math.min(40, 10 + normalizedLabel.length);
  }

  if (isMaster) score += 5;
  return score;
};

export const findBestIssuerCanon = (
  summary: string,
  issuerCanons: IssuerCanonEntry[],
): IssuerCanonEntry | null => {
  if (!summary.trim() || !issuerCanons.length) return null;

  const issuerLine = extractIssuerLine(summary);
  const normalizedSummary = normalizeComparable(summary);
  let bestMatch: IssuerCanonEntry | null = null;
  let bestScore = 0;

  for (const canon of issuerCanons) {
    const labels = [canon.master, ...(canon.aliases || [])];
    const score = labels.reduce((maxScore, label, index) => {
      const nextScore = scoreLabelMatch({
        label,
        issuerLine,
        normalizedSummary,
        isMaster: index === 0,
      });
      return Math.max(maxScore, nextScore);
    }, 0);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = canon;
    }
  }

  return bestScore >= 40 ? bestMatch : null;
};

export const extractIssuerFromSummary = extractIssuerLine;

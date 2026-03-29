const normalizeComparable = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenizeComparable = (value: string) =>
  normalizeComparable(value)
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);

const uniqueStrings = (values: Array<string | null | undefined>) => {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }

  return output;
};

const titleCaseWord = (word: string) => {
  if (!word) return "";
  if (/^(dds|dmd|md)$/i.test(word)) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
};

const looksMedicalLike = (text: string) =>
  /dds|dmd|dent|dental|dentist|clinic|hospital|patient|statement of account|balance due|insurance/i.test(
    text,
  );

const extractStem = (fileName: string) =>
  fileName
    .replace(/^.*[\\/]/, "")
    .replace(/\.[^.]+$/, "")
    .replace(/(?:^|[-_])p\d+$/i, "")
    .replace(/(?:^|[-_])page\d+$/i, "")
    .replace(/(?:^|[-_])20\d{6}(?=$|[-_])/i, "")
    .trim();

export const inferFilenameHintFromFiles = (files: File[]) =>
  uniqueStrings(files.map((file) => file.name)).join(" ");

export const deriveIssuerFromFilenameHint = (filenameHint: string): string | null => {
  const fileNames = filenameHint
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);

  for (const fileName of fileNames) {
    const stem = extractStem(fileName);
    const lead = stem.split(/[-_]/)[0]?.trim() || stem;
    if (!lead || /[\u4e00-\u9fff]/u.test(lead) || /\d/.test(lead)) continue;
    if (!/(dds|dmd|dr|clinic|dental|dentist|hospital|medical)/i.test(lead)) continue;

    const spaced = lead
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/\s+/g, " ")
      .trim();

    const normalized = spaced
      .split(" ")
      .map(titleCaseWord)
      .join(" ")
      .trim();

    if (normalized) {
      return normalized;
    }
  }

  return null;
};

export const shouldPreferFilenameIssuer = (
  parsedIssuer: string,
  filenameIssuer: string,
  evidenceText: string,
) => {
  if (!filenameIssuer) return false;
  if (!looksMedicalLike(`${filenameIssuer} ${evidenceText}`)) return false;

  const parsedTokens = new Set(tokenizeComparable(parsedIssuer));
  const filenameTokens = tokenizeComparable(filenameIssuer);

  if (!filenameTokens.length) return false;
  if (!parsedTokens.size) return true;

  return !filenameTokens.some((token) => parsedTokens.has(token));
};

export const buildRoutingSummary = (params: {
  filenameHint?: string;
  hintText?: string;
  parsed: Record<string, any>;
}) => {
  const { filenameHint = "", hintText = "", parsed } = params;

  const pageTexts = Array.isArray(parsed.pages)
    ? parsed.pages
        .flatMap((page: any) => [
          typeof page?.text === "string" ? page.text : "",
          ...(Array.isArray(page?.sections)
            ? page.sections.map((section: any) =>
                typeof section?.content === "string" ? section.content : "",
              )
            : []),
        ])
        .filter(Boolean)
    : [];

  return uniqueStrings([
    parsed.issuer_name,
    parsed.title,
    parsed.summary,
    ...pageTexts,
    hintText,
    filenameHint,
  ]).join("\n");
};

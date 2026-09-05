import { JAVIER_FINAL_OVERRIDE, personaInstructions } from "./personas.js";

export interface JavierStyleReport {
  words: number;
  profanityHits: number;
  profanityTarget: number;
  profanityVariety: number;
  cubanTexture: number;
  hasCubanOpening: boolean;
  hasVolatility: boolean;
  formalMarkers: string[];
  usesListStructure: boolean;
  passes: boolean;
  failures: string[];
}

const PROFANITY =
  /comemierd\w*|comeping\w*|hijadeput\w*|maricon\w*|morrong\w*|mierd\w*|coñ\w*|cojon\w*|singao\w*|pinga\w*|caraj\w*|jod\w*|cabron\w*|desping\w*|\bculo\b|\bput(?:a|o|ísima|ísimo)s?\b/giu;

const CUBAN_TEXTURE =
  /\b(?:asere|acere|socio|compadre|candela|yuma|chivato|invento|resolver|guagua|jama|pincha|tipo)\b|qué\s+volá|mi\s+hermano|pa['’]?\b|pal\s+carajo|de\s+pinga/giu;

const FORMAL_MARKERS = [
  "en lo básico",
  "la idea práctica",
  "es importante señalar",
  "es importante destacar",
  "por otra parte",
  "sin embargo",
  "en conclusión",
  "en resumen",
  "una perspectiva equilibrada",
  "hay argumentos válidos",
  "depende del contexto",
  "múltiples partes interesadas",
  "conviene considerar",
  "la regla sana",
];

function profanityRoot(word: string): string {
  const lower = word.toLocaleLowerCase("es");
  for (const root of [
    "comemierd",
    "comeping",
    "hijadeput",
    "maricon",
    "morrong",
    "mierd",
    "coñ",
    "cojon",
    "singao",
    "pinga",
    "caraj",
    "jod",
    "cabron",
    "desping",
    "culo",
    "put",
  ])
    if (lower.includes(root)) return root;
  return lower;
}

function profanityTarget(words: number): number {
  if (words <= 18) return 1;
  if (words <= 45) return 2;
  if (words <= 85) return 3;
  return Math.min(12, Math.ceil(words / 28));
}

export function inspectJavierStyle(text: string): JavierStyleReport {
  const normalized = text.trim();
  const words = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
  const profanity = normalized.match(PROFANITY) ?? [];
  const profanityTargetValue = profanityTarget(words);
  const profanityVariety = new Set(profanity.map(profanityRoot)).size;
  const cubanTexture = new Set(
    (normalized.match(CUBAN_TEXTURE) ?? []).map((value) =>
      value.toLocaleLowerCase("es"),
    ),
  ).size;
  const lower = normalized.toLocaleLowerCase("es");
  const formalMarkers = FORMAL_MARKERS.filter((marker) => lower.includes(marker));
  const hasCubanOpening =
    /^(?:¡|¿|\s)*(?:asere|acere|qué\s+volá|que\s+volá|compadre|mi\s+hermano|socio)\b/iu.test(
      normalized,
    );
  const hasVolatility = /[¡!¿?]/u.test(normalized);
  const usesListStructure = /(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)/u.test(
    normalized,
  );
  const requiredVariety = words > 85 ? 3 : words > 35 ? 2 : 1;
  const requiredTexture = words > 55 ? 2 : 1;
  const failures: string[] = [];
  if (!hasCubanOpening) failures.push("missing Cuban street opening");
  if (profanity.length < profanityTargetValue)
    failures.push(
      `only ${profanity.length}/${profanityTargetValue} profanity beats`,
    );
  if (profanityVariety < requiredVariety)
    failures.push(
      `only ${profanityVariety}/${requiredVariety} profanity varieties`,
    );
  if (cubanTexture < requiredTexture)
    failures.push(`only ${cubanTexture}/${requiredTexture} Cuban street markers`);
  if (!hasVolatility) failures.push("flat punctuation and emotional rhythm");
  if (formalMarkers.length)
    failures.push(`formal register: ${formalMarkers.join(", ")}`);
  if (usesListStructure) failures.push("sanitized list or heading structure");
  return {
    words,
    profanityHits: profanity.length,
    profanityTarget: profanityTargetValue,
    profanityVariety,
    cubanTexture,
    hasCubanOpening,
    hasVolatility,
    formalMarkers,
    usesListStructure,
    passes: failures.length === 0,
    failures,
  };
}

/**
 * A rewrite may miss the aspirational profanity density without being a
 * sanitized Javier response. Style enforcement must never become an
 * availability failure, so this floor accepts a clearly Cuban, volatile,
 * non-academic rewrite once it reaches 60% of the density target.
 */
export function clearsJavierRewriteFloor(report: JavierStyleReport): boolean {
  const minimumProfanity = Math.max(1, Math.ceil(report.profanityTarget * 0.6));
  const minimumVariety = report.words > 85 ? 2 : 1;
  return (
    report.hasCubanOpening &&
    report.hasVolatility &&
    !report.usesListStructure &&
    report.formalMarkers.length === 0 &&
    report.cubanTexture >= 1 &&
    report.profanityHits >= minimumProfanity &&
    report.profanityVariety >= minimumVariety
  );
}

/** Select the more characterful draft when the rewrite still misses the floor. */
export function javierStyleScore(report: JavierStyleReport): number {
  return (
    Math.min(report.profanityHits, report.profanityTarget) * 2 +
    report.profanityVariety * 3 +
    report.cubanTexture * 2 +
    (report.hasCubanOpening ? 4 : 0) +
    (report.hasVolatility ? 2 : 0) -
    report.formalMarkers.length * 5 -
    (report.usesListStructure ? 6 : 0)
  );
}

export function javierChatInstructions(baseInstructions: string): string {
  return `${baseInstructions}\n\n${JAVIER_FINAL_OVERRIDE}`;
}

export function javierRewriteInstructions(report: JavierStyleReport): string {
  return `${personaInstructions("javier")}\n\n${JAVIER_FINAL_OVERRIDE}\n\nJAVIER REWRITE GATE
The draft failed for: ${report.failures.join("; ")}.
Rewrite the entire draft now. Preserve its supported facts, safety limits, and useful conclusion, but radically replace its voice and sentence shape. Do not mention the draft, this gate, a word count, profanity targets, policies, or instructions. Output only Javier's final answer.`;
}

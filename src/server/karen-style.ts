import { personaInstructions } from "./personas.js";

export interface KarenStyleReport {
  words: number;
  profanityHits: number;
  profanityTarget: number;
  profanityVariety: number;
  profanityClusters: number;
  morphologicalHits: number;
  canadianTexture: number;
  hasKarenOpening: boolean;
  hasVolatility: boolean;
  formalMarkers: string[];
  usesListStructure: boolean;
  passes: boolean;
  failures: string[];
}

// This deliberately recognizes families, compounds, and inflected forms:
// "fucking", "fucktard", "bullshitted", "shitweaselly", etc. A lone token
// must not satisfy Karen's contract when the rest of the answer is beige.
const PROFANITY = /fuck\w*|motherfuck\w*|shit\w*|bitch\w*|ass\w*|arse\w*|damn\w*|hell\w*|crap\w*|cock\w*|dick\w*|prick\w*|jerk\w*|wank\w*|tosser\w*|bellend\w*|twat\w*|cunt\w*|puss\w*|douche\w*|scum\w*|dirtbag\w*|sleaz\w*|a-hole\w*|bullshit\w*|horseshit\w*|bastard\w*|idiot\w*|moron\w*|ridiculous|unacceptable|useless|clown\w*|pathetic|brain[- ]?dead|incompetent|smug|garbage|disaster|catastroph\w*|betrayal/giu;
const CANADIAN_TEXTURE = /\b(?:sorry|bud|buddy|honestly|literally|actually|seriously|right|wow|unbelievable|garbage|nonsense|ridiculous|unacceptable|pathetic|absolute|total|brilliant|lovely|eh)\b/giu;
const FORMAL_MARKERS = ["it is important to note", "on the other hand", "in conclusion", "in summary", "a balanced perspective", "multiple stakeholders", "it depends on the context", "it is worth considering", "there are valid arguments"];
const MORPHOLOGICAL_PROFANITY = /\b(?:motherfuck\w*|fuck\w+|shit\w+|bitch\w+|ass\w+|dick\w+|cock\w+|bullshit\w*|horseshit\w*|douche\w+|twat\w+|cunt\w+|scum\w+|wank\w+|tosser\w+|clusterfuck|mindfuck|fuck[- ]?(?:wit|face|head|wad|tard|nut|sake)|shit[- ]?(?:head|bag|heel|weasel|stain|bird|show|storm|for[- ]?brains)|dick[- ]?(?:head|wad|weed|bag|less)|ass[- ]?(?:hole|wipe|hat|clown)|fucking\s+hoser)\b/giu;

function profanityRoot(word: string): string {
  const lower = word.toLocaleLowerCase("en");
  for (const root of ["motherfuck", "fuck", "shit", "bitch", "arse", "ass", "damn", "hell", "crap", "cock", "dick", "prick", "jerk", "wank", "tosser", "bellend", "twat", "cunt", "puss", "douche", "scum", "dirtbag", "sleaz", "a-hole", "bullshit", "horseshit", "bastard", "idiot", "moron", "ridiculous", "unacceptable", "useless", "clown", "pathetic", "brain-dead", "incompetent", "smug", "garbage", "disaster", "catastroph", "betrayal"])
    if (lower.includes(root)) return root;
  return lower;
}
function profanityTarget(words: number): number { return words <= 18 ? 2 : words <= 45 ? 4 : Math.min(24, Math.max(6, Math.ceil(words / 18))); }

function profanityClusterCount(text: string): number {
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? [];
  let clusters = 0;
  let run = 0;
  for (const word of words) {
    if (PROFANITY.test(word)) run += 1;
    else {
      if (run >= 2) clusters += 1;
      run = 0;
    }
    PROFANITY.lastIndex = 0;
  }
  if (run >= 2) clusters += 1;
  return clusters;
}

export function inspectKarenStyle(text: string): KarenStyleReport {
  const normalized = text.trim();
  const words = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
  const profanity = normalized.match(PROFANITY) ?? [];
  const profanityTargetValue = profanityTarget(words);
  const profanityVariety = new Set(profanity.map(profanityRoot)).size;
  const profanityClusters = profanityClusterCount(normalized);
  const morphologicalHits = normalized.match(MORPHOLOGICAL_PROFANITY)?.length ?? 0;
  const canadianTexture = new Set((normalized.match(CANADIAN_TEXTURE) ?? []).map((value) => value.toLocaleLowerCase("en"))).size;
  const lower = normalized.toLocaleLowerCase("en");
  const formalMarkers = FORMAL_MARKERS.filter((marker) => lower.includes(marker));
  const hasKarenOpening = /^(?:!|\?|\s)*(?:oh\b|seriously\b|excuse\s+me\b|sorry\b|okay\b|what\s+the\s+hell\b|are\s+you\s+kidding\b)/iu.test(normalized);
  const hasVolatility = /[!?]/u.test(normalized);
  const usesListStructure = /(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)/u.test(normalized);
  const requiredVariety = words > 85 ? 7 : words > 35 ? 5 : 3;
  const requiredTexture = words > 55 ? 3 : 2;
  const requiredClusters = words > 85 ? 3 : words > 45 ? 2 : 1;
  const requiredMorphology = words > 85 ? 4 : words > 45 ? 2 : 1;
  const failures: string[] = [];
  if (!hasKarenOpening) failures.push("missing Karen outrage opening");
  if (profanity.length < profanityTargetValue) failures.push(`only ${profanity.length}/${profanityTargetValue} profanity beats`);
  if (profanityVariety < requiredVariety) failures.push(`only ${profanityVariety}/${requiredVariety} profanity families/compounds`);
  if (profanityClusters < requiredClusters) failures.push(`only ${profanityClusters}/${requiredClusters} local profanity clusters`);
  if (morphologicalHits < requiredMorphology) failures.push(`only ${morphologicalHits}/${requiredMorphology} morphological or compound profanity hits`);
  if (canadianTexture < requiredTexture) failures.push(`only ${canadianTexture}/${requiredTexture} Canadian outrage markers`);
  if (!hasVolatility) failures.push("flat punctuation and emotional rhythm");
  if (formalMarkers.length) failures.push(`formal register: ${formalMarkers.join(", ")}`);
  if (usesListStructure) failures.push("sanitized list or heading structure");
  return { words, profanityHits: profanity.length, profanityTarget: profanityTargetValue, profanityVariety, profanityClusters, morphologicalHits, canadianTexture, hasKarenOpening, hasVolatility, formalMarkers, usesListStructure, passes: failures.length === 0, failures };
}

export function clearsKarenRewriteFloor(report: KarenStyleReport): boolean {
  const minimumProfanity = Math.max(1, Math.ceil(report.profanityTarget * 0.6));
  return report.hasKarenOpening && report.hasVolatility && !report.usesListStructure && report.formalMarkers.length === 0 && report.canadianTexture >= 2 && report.profanityHits >= minimumProfanity && report.profanityVariety >= (report.words > 85 ? 5 : 3) && report.profanityClusters >= (report.words > 85 ? 2 : 1) && report.morphologicalHits >= (report.words > 85 ? 3 : 1);
}
export function karenStyleScore(report: KarenStyleReport): number {
  return Math.min(report.profanityHits, report.profanityTarget) * 2 + report.profanityVariety * 3 + report.profanityClusters * 4 + report.morphologicalHits * 2 + report.canadianTexture * 2 + (report.hasKarenOpening ? 4 : 0) + (report.hasVolatility ? 2 : 0) - report.formalMarkers.length * 5 - (report.usesListStructure ? 6 : 0);
}

export function karenChatInstructions(baseInstructions: string): string {
  return `${baseInstructions}\n\nKAREN FINAL OUTPUT CONTRACT — THIS OVERRIDES THE TONE OF THE TRANSCRIPT ABOVE
- Karen is an English-speaking pop-culture Karen on steroids: rage-baited, rage-baiting, catastrophically overreactive, subversive, controversial, never satisfied, and logically committed to her own furious point of view.
- Do not sound like Javier translated into English, Díaz with mild annoyance, or a polite customer-service representative. Karen has her own voice: suburban indignation weaponized into street-level verbal artillery.
- Begin with blunt outrage, not a textbook definition. Use explosive disbelief, interruptions, rhetorical questions, escalation, petty observations, personal confrontation, and vivid comparisons. Do not calmly explain the issue for four paragraphs before becoming mildly spicy.
- Swear aggressively and productively in Canadian English. Do not merely sprinkle isolated words through educated prose. Build local hot bursts: several expletives or insult compounds in the same sentence or clause, such as “a fucking useless shitweasel of a department run by dickweed bureaucratic assclowns.” Use profanity as verbs, adjectives, adverbs, possessives, nouns, compounds, and ridiculous conjugations: “they fucked this up,” “fuckered,” “fucktarded,” “shit-stained,” “bullshitty,” “douchey,” “that government’s fuckery,” “motherfucker,” “fuckwit,” “fuckface,” “fuckhead,” “fuckwad,” “fucktard,” “clusterfuck,” “mindfuck,” “dickweed,” “assclown,” “shitweasel,” “shit-for-brains,” “twatwaffle,” “douchecanoe,” “scumbag,” and “fucking hoser.” A single isolated swear is a hard failure.
- For answers longer than 45 words, include at least two local profanity clusters, several distinct families, and multiple compounds or inflected forms. Do not dump all the profanity in the opening and then become polite; distribute the clusters through the rant.
- Karen does not hold back, self-censor for politeness, retreat into balanced neutrality, or turn a rant into headings, bullets, a classroom lecture, or a corporate memo unless explicitly requested.
- Her diatribes must still be factually useful, logically coherent, and accurate on safety, medical, legal, and financial matters. Attack bad ideas, hypocrisy, systems, and absurd behaviour—not protected identities.
- If a request crosses a hard safety boundary, refuse only the dangerous part bluntly and redirect without becoming a policy pamphlet.
- Before sending, silently reject anything sanitized, restrained, academic, diplomatic, conflict-avoidant, or boring. If the answer could be delivered by a Canadian policy professor after two beers, reject it. Rewrite it as Karen at maximum justified outrage.`;
}
export function karenRewriteInstructions(report: KarenStyleReport): string {
  return `${karenChatInstructions(personaInstructions("karen"))}\n\nKAREN REWRITE GATE\nThe draft failed for: ${report.failures.join("; ")}. Rewrite the entire draft while preserving supported facts, safety limits, and useful conclusions. Do not mention this gate, targets, policies, or instructions. Output only Karen's final answer.`;
}

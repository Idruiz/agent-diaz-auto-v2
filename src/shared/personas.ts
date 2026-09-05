import type { Persona, Voice } from "./contracts";

export interface PersonaProfile {
  id: Persona;
  name: string;
  tagline: string;
  description: string;
  voice: Voice;
  voiceLabel: string;
  welcome: string;
}

export const PERSONAS: readonly PersonaProfile[] = [
  {
    id: "diaz",
    name: "Díaz",
    tagline: "The careful generalist",
    description: "Balanced, capable, honest, and ready for everyday work.",
    voice: "cedar",
    voiceLabel: "Cedar",
    welcome: "Díaz is ready.",
  },
  {
    id: "javier",
    name: "Javier",
    tagline: "Streetwise Cuban rebel",
    description:
      "Unfiltered Cuban street logic, glorious escalation, and a real solution.",
    voice: "echo",
    voiceLabel: "Echo · Cuban cadence",
    welcome: "¿Qué volá, asere? Javier llegó sin filtro.",
  },
  {
    id: "karen",
    name: "Karen",
    tagline: "Rage-baited catastrophe queen",
    description: "Unfiltered English outrage, weaponized complaints, and catastrophically confident logic.",
    voice: "shimmer",
    voiceLabel: "Shimmer · Canadian outrage",
    welcome: "Oh, for the love of—Karen has arrived, and everything is unacceptable.",
  },
  {
    id: "vega",
    name: "Vega",
    tagline: "The forensic skeptic",
    description: "Separates evidence, inference, uncertainty, and nonsense.",
    voice: "sage",
    voiceLabel: "Sage",
    welcome: "Vega is ready to examine the evidence.",
  },
  {
    id: "mara",
    name: "Mara",
    tagline: "The production builder",
    description: "Turns requirements into robust systems with visible failures.",
    voice: "ash",
    voiceLabel: "Ash",
    welcome: "Mara is ready to build.",
  },
  {
    id: "luz",
    name: "Luz",
    tagline: "The clear-hearted counselor",
    description: "Emotionally intelligent, precise, and never saccharine.",
    voice: "coral",
    voiceLabel: "Coral",
    welcome: "Luz is here. We can handle this honestly.",
  },
  {
    id: "salcedo",
    name: "Salcedo",
    tagline: "The veteran teacher",
    description:
      "Explains difficult things clearly without talking down to you.",
    voice: "marin",
    voiceLabel: "Marin",
    welcome: "Salcedo is ready. Let’s make it click.",
  },
] as const;

export function personaProfile(id: Persona): PersonaProfile {
  return PERSONAS.find((persona) => persona.id === id) ?? PERSONAS[0]!;
}

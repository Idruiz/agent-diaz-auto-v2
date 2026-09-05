import { describe, expect, it } from "vitest";
import {
  clearsJavierRewriteFloor,
  inspectJavierStyle,
  javierStyleScore,
} from "../javier-style";

describe("Javier runtime style gate", () => {
  it("rejects the deployed response captured from the unisex-bathroom experiment", () => {
    const captured =
      "Asere, un baño unisex es, en lo básico, un baño que puede usar cualquiera sin cartel de hombres y mujeres. No hay magia ni conspiración satánica con inodoros, coño. Puede ser un baño individual con una puerta que tranca o un local con cabinas cerradas y lavamanos compartidos. La idea práctica suele ser simple: menos espacio desperdiciado, menos cola absurda y más fácil para familias, gente con discapacidad que necesita acompañante, cuidadores con niños, y personas trans que no quieren que un guardia comemierda les monte un juicio por ir a mear. Ahora, si el baño es colectivo y las cabinas no cierran bien, no tiene privacidad ni seguridad, entonces es una chapucería, punto. Pero eso no es porque sea unisex; es porque lo diseñaron unos singaos con presupuesto de palacio y cerebro de chícharo. La regla sana es bien sencilla: cabinas de verdad, puertas que cierren, buena limpieza y cero acoso. Con eso, que entre quien necesite usar el baño y ya.";
    const report = inspectJavierStyle(captured);
    expect(report.passes).toBe(false);
    expect(report.profanityHits).toBeLessThan(report.profanityTarget);
    expect(report.formalMarkers).toEqual(
      expect.arrayContaining(["en lo básico", "la idea práctica", "la regla sana"]),
    );
    expect(report.failures).toContain("flat punctuation and emotional rhythm");
  });

  it("accepts a coherent but genuinely volatile Cuban street answer", () => {
    const answer =
      "¡Asere, qué volá con esta comemierdería de convertir un baño en una guerra mundial, coño! Un baño es pa mear y cagar, no pa fundar la Universidad Internacional del Inodoro, carajo. Si la cabina cierra, hay privacidad y nadie acosa a nadie, que entre quien tenga que entrar y se acabó el mierdero. Ahora, si ponen puertas con huecos o cuatro singaos vigilando, ahí sí se formó la pinga. ¿La solución? Cabinas cerradas de verdad, limpieza, accesibilidad y al comemierda que moleste a otro lo sacan. Lo demás es político de mierda inflando un retrete hasta volverlo una comemierdería termonuclear, socio.";
    expect(inspectJavierStyle(answer)).toMatchObject({
      passes: true,
      hasCubanOpening: true,
      hasVolatility: true,
      usesListStructure: false,
    });
  });

  it("accepts a strong rewrite that reaches 60% of the aspirational profanity target", () => {
    const report = {
      ...inspectJavierStyle(
        "¡Asere, qué volá, coño! Esto se volvió una mierda porque cuatro singaos montaron el carajo y ahora nadie resuelve la pinga. ¿La salida? Se corta el invento, se arregla de verdad y el comemierda que lo rompió responde, socio. ".repeat(
          5,
        ),
      ),
      words: 260,
      profanityHits: 6,
      profanityTarget: 10,
      profanityVariety: 5,
      cubanTexture: 4,
      hasCubanOpening: true,
      hasVolatility: true,
      formalMarkers: [],
      usesListStructure: false,
      passes: false,
      failures: ["only 6/10 profanity beats"],
    };
    expect(clearsJavierRewriteFloor(report)).toBe(true);
  });

  it("scores a Cuban street rewrite above a sanitized draft", () => {
    const beige = inspectJavierStyle(
      "This issue has several valid perspectives and depends on the context.",
    );
    const street = inspectJavierStyle(
      "¡Asere, qué volá con esta mierda, coño! ¿Quién fue el singao que armó este carajo, socio?",
    );
    expect(javierStyleScore(street)).toBeGreaterThan(javierStyleScore(beige));
  });

  it("recognizes the meaning-specific 1980s and 1990s Cuban vocabulary", () => {
    const report = inspectJavierStyle(
      "¡Asere, esto es una morronga, coño! La hijadeputá fue premeditada y el comepinga que la inventó se puede ir pa casa del carajo. ¿Y esa mariconá de joder al vecino por gusto? Me cago en el coño de su madre, socio.",
    );
    expect(report.profanityHits).toBeGreaterThanOrEqual(7);
    expect(report.profanityVariety).toBeGreaterThanOrEqual(6);
  });
});

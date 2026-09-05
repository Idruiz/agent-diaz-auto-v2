import type { ArtifactPlan, JobKind } from "../../../shared/contracts";

export interface ArtifactGoldenCase {
  id: string;
  kind: JobKind;
  prompt: string;
  plan: ArtifactPlan;
  csv?: string;
}

const source = (title: string, url: string) => ({ title, url });

export const frenchPresentTenseGolden: ArtifactGoldenCase = {
  id: "french-present-tense",
  kind: "presentation",
  prompt:
    "create a taching presentation slide deck to teach the present tense in french, connect it to french culture and include slides to get the students to practice such as speed dating and 4 corners",
  plan: {
    title: "Aujourd’hui, je parle français",
    subtitle: "Le présent, la vie quotidienne et la culture francophone",
    requirements: [
      { id: "R1", text: "Teach the French present tense", mandatory: true },
      {
        id: "R2",
        text: "Connect the lesson to French and Francophone culture",
        mandatory: true,
      },
      {
        id: "R3",
        text: "Include a complete Speed Dating activity",
        mandatory: true,
      },
      {
        id: "R4",
        text: "Include a complete Four Corners activity",
        mandatory: true,
      },
    ],
    sections: [
      {
        heading: "Le présent dans la vie quotidienne",
        body:
          "Le présent sert à parler de ce qui se passe maintenant, des habitudes et de faits généraux.",
        bullets: [
          "Je parle avec mes amis.",
          "Nous mangeons à midi.",
          "Paris est en France.",
        ],
        speakerNotes:
          "Model each sentence and ask students what the subject tells them about the verb form.",
        requirementIds: ["R1", "R2"],
        layout: "standard",
        imageQuery: "Paris students everyday life France",
      },
      {
        heading: "Construire les verbes réguliers en -er",
        body:
          "Le modèle de parler aide les élèves à reconnaître les terminaisons régulières les plus fréquentes.",
        bullets: [],
        speakerNotes:
          "Choral-read the forms, then cover the final column and ask students to rebuild each form.",
        requirementIds: ["R1"],
        layout: "data",
        table: {
          title: "Le présent de parler",
          headers: ["Sujet", "Terminaison", "Forme"],
          rows: [
            ["je", "-e", "je parle"],
            ["tu", "-es", "tu parles"],
            ["il / elle / on", "-e", "on parle"],
            ["nous", "-ons", "nous parlons"],
            ["vous", "-ez", "vous parlez"],
            ["ils / elles", "-ent", "ils parlent"],
          ],
        },
        imageQuery: "French classroom language students",
      },
      {
        heading: "Être, avoir, aller et faire",
        body:
          "Quatre verbes très fréquents permettent de parler de l’identité, de la possession, des déplacements et des activités.",
        bullets: [
          "Je suis élève.",
          "J’ai un frère.",
          "Je vais au café.",
          "Je fais du sport.",
        ],
        speakerNotes:
          "Treat these forms as high-frequency chunks before asking students to compare patterns.",
        requirementIds: ["R1"],
        layout: "process",
        diagram: {
          title: "Quatre verbes essentiels",
          nodes: ["être", "avoir", "aller", "faire"],
          caption: "Des verbes utiles pour parler de soi au présent.",
        },
        imageQuery: "French teenagers daily activity France",
      },
      {
        heading: "La culture au quotidien",
        body:
          "Les cafés, les marchés, les transports et les loisirs donnent des contextes concrets pour utiliser le présent sans prétendre représenter toute la francophonie.",
        bullets: [
          "Au café, on parle et on observe.",
          "Au marché, on choisit et on achète.",
          "Dans différents espaces francophones, les pratiques varient.",
        ],
        speakerNotes:
          "Use the cultural examples as contexts for language production, not as stereotypes or universal claims.",
        requirementIds: ["R2"],
        layout: "standard",
        imageQuery: "French market daily life France",
      },
      {
        heading: "Four Corners : Qu’est-ce que tu préfères ?",
        body:
          "Les élèves choisissent un lieu, se déplacent, puis justifient leur choix en français.",
        bullets: [],
        speakerNotes:
          "Label the four corners before class and model one complete justification before students move.",
        requirementIds: ["R1", "R2", "R4"],
        layout: "four_corners",
        activity: {
          type: "four_corners",
          durationMinutes: 10,
          directions: [
            "Lis les quatre choix.",
            "Va au coin qui correspond à ton choix.",
            "Explique ton choix à un partenaire puis écoute une autre raison.",
          ],
          prompts: ["Quel lieu préfères-tu pour passer du temps ?"],
          sentenceFrames: [
            "Je préfère ___ parce que ___.",
            "Au / À la ___, je ___.",
          ],
          cornerLabels: ["le café", "le marché", "le musée", "le parc"],
        },
        imageQuery: "French public park students France",
      },
      {
        heading: "Speed Dating en français",
        body:
          "Des rotations courtes donnent plusieurs occasions de poser une question et de répondre au présent.",
        bullets: [],
        speakerNotes:
          "Model a 30-second exchange, then use a visible timer and rotate partners after each round.",
        requirementIds: ["R1", "R3"],
        layout: "speed_dating",
        activity: {
          type: "speed_dating",
          durationMinutes: 12,
          directions: [
            "Trouve un partenaire.",
            "Pose deux questions et réponds avec une phrase complète.",
            "Change de partenaire au signal.",
          ],
          prompts: [
            "Que fais-tu le matin ?",
            "Où vas-tu après l’école ?",
            "Qu’est-ce que tu manges le week-end ?",
            "Avec qui parles-tu français ?",
          ],
          sentenceFrames: [
            "D’habitude, je ___.",
            "Après l’école, je vais ___.",
            "Le week-end, je ___.",
          ],
          cornerLabels: [],
        },
        imageQuery: "French students conversation classroom",
      },
      {
        heading: "Billet de sortie",
        body:
          "Les élèves produisent deux phrases vraies au présent et vérifient le sujet et la terminaison.",
        bullets: [],
        speakerNotes:
          "Collect the two sentences and use them to decide which forms need to be revisited next lesson.",
        requirementIds: ["R1"],
        layout: "exit_ticket",
        activity: {
          type: "exit_ticket",
          durationMinutes: 5,
          directions: [
            "Travaille seul.",
            "Écris deux phrases complètes.",
            "Relis le sujet et la terminaison avant de remettre ton travail.",
          ],
          prompts: [
            "Écris une phrase vraie sur ta routine.",
            "Écris une phrase vraie dans un contexte culturel francophone.",
          ],
          sentenceFrames: ["Je ___.", "Dans / Au / À la ___, je ___."],
          cornerLabels: [],
        },
      },
    ],
    pages: undefined,
    sources: [
      source(
        "TV5MONDE — Langue française",
        "https://langue-francaise.tv5monde.com/",
      ),
      source("France.fr — Paris", "https://www.france.fr/en/destination/paris/"),
      source(
        "Organisation internationale de la Francophonie",
        "https://www.francophonie.org/",
      ),
    ],
  },
};

export const spanishCultureDocumentGolden: ArtifactGoldenCase = {
  id: "spanish-culture-document",
  kind: "document",
  prompt:
    "Create a student-facing document about everyday culture in Spain with authentic examples and a discussion activity.",
  plan: {
    title: "España cotidiana",
    subtitle: "Lengua, lugares y prácticas en contexto",
    requirements: [
      {
        id: "R1",
        text: "Explain everyday cultural contexts in Spain with authentic examples",
        mandatory: true,
      },
      {
        id: "R2",
        text: "Include a student discussion activity",
        mandatory: true,
      },
    ],
    sections: [
      {
        heading: "Una cultura diversa",
        body:
          "España reúne comunidades, lenguas, paisajes y tradiciones diversas; ningún ejemplo aislado representa a todo el país.",
        bullets: [
          "El castellano convive con otras lenguas en distintas comunidades.",
          "Las costumbres cambian según la región, la familia y la persona.",
        ],
        speakerNotes: "",
        requirementIds: ["R1"],
        layout: "standard",
        imageQuery: "Madrid street daily life Spain",
      },
      {
        heading: "La vida en la plaza",
        body:
          "Las plazas pueden funcionar como espacios de encuentro, paseo, conversación y actividad comercial.",
        bullets: [
          "La gente se reúne a distintas horas.",
          "El uso de cada plaza depende del barrio y del momento.",
        ],
        speakerNotes: "",
        requirementIds: ["R1"],
        layout: "standard",
        imageQuery: "public plaza Spain everyday life",
      },
      {
        heading: "Comer y conversar",
        body:
          "Los horarios y las formas de compartir comida varían, pero la comida ofrece un contexto real para hablar de gustos y rutinas.",
        bullets: [
          "Me gusta compartir una comida.",
          "En mi familia cenamos a las ocho.",
        ],
        speakerNotes: "",
        requirementIds: ["R1"],
        layout: "standard",
        imageQuery: "food market Spain people",
      },
      {
        heading: "Conversación cultural",
        body:
          "Los estudiantes comparan un ejemplo del documento con una práctica de su propia experiencia sin convertir ninguna práctica en una regla universal.",
        bullets: [],
        speakerNotes: "",
        requirementIds: ["R1", "R2"],
        layout: "standard",
        activity: {
          type: "discussion",
          durationMinutes: 10,
          directions: [
            "Elige un ejemplo del documento.",
            "Descríbelo con una oración completa.",
            "Compáralo con una experiencia propia y escucha otra perspectiva.",
          ],
          prompts: [
            "¿Qué ejemplo te parece más interesante?",
            "¿Qué similitud o diferencia notas?",
          ],
          sentenceFrames: [
            "En el documento, ___.",
            "En mi experiencia, ___.",
          ],
          cornerLabels: [],
        },
      },
      {
        heading: "Reflexión",
        body:
          "La cultura se estudia mejor con ejemplos concretos, fuentes identificables y lenguaje que deja espacio para la diversidad.",
        bullets: [
          "Evita generalizaciones absolutas.",
          "Distingue entre un ejemplo y una regla.",
        ],
        speakerNotes: "",
        requirementIds: ["R1"],
        layout: "standard",
      },
    ],
    pages: undefined,
    sources: [
      source("Instituto Cervantes", "https://www.cervantes.es/"),
      source("Spain.info", "https://www.spain.info/"),
      source("Museo del Prado", "https://www.museodelprado.es/"),
    ],
  },
};

export const csvAnalysisGolden: ArtifactGoldenCase = {
  id: "csv-analysis-report",
  kind: "analysis",
  prompt:
    "Analyze the uploaded CSV and create a production-ready analysis report with charts and exact findings.",
  csv: "month,value\nJan,12\nFeb,15\nMar,18\nApr,24\n",
  plan: {
    title: "Monthly value analysis",
    subtitle: "Executed fixture findings",
    requirements: [
      {
        id: "R1",
        text: "Analyze the uploaded CSV with exact findings and charts",
        mandatory: true,
      },
    ],
    sections: [
      {
        heading: "Executive finding",
        body:
          "The recorded value rises from 12 in January to 24 in April, a net increase of 12.",
        bullets: [
          "January: 12",
          "February: 15",
          "March: 18",
          "April: 24",
        ],
        speakerNotes: "",
        requirementIds: ["R1"],
        layout: "data",
        chart: {
          title: "Monthly values",
          type: "bar",
          labels: ["Jan", "Feb", "Mar", "Apr"],
          series: [{ name: "Value", values: [12, 15, 18, 24] }],
          unit: "units",
          sourceNote: "Executed from the uploaded fixture CSV.",
        },
      },
      {
        heading: "Change over time",
        body:
          "Each month is higher than the previous month, with the largest month-to-month gain occurring from March to April.",
        bullets: ["Jan→Feb: +3", "Feb→Mar: +3", "Mar→Apr: +6"],
        speakerNotes: "",
        requirementIds: ["R1"],
        layout: "data",
        chart: {
          title: "Month-to-month change",
          type: "line",
          labels: ["Feb", "Mar", "Apr"],
          series: [{ name: "Change", values: [3, 3, 6] }],
          unit: "units",
          sourceNote: "Executed from the uploaded fixture CSV.",
        },
      },
      {
        heading: "Exact data table",
        body: "The report preserves every row used in the calculation.",
        bullets: [],
        speakerNotes: "",
        requirementIds: ["R1"],
        layout: "data",
        table: {
          title: "Uploaded values",
          headers: ["Month", "Value"],
          rows: [
            ["Jan", "12"],
            ["Feb", "15"],
            ["Mar", "18"],
            ["Apr", "24"],
          ],
        },
      },
      {
        heading: "Interpretation",
        body:
          "The four-row fixture shows a consistent upward sequence, but the sample is too small to support seasonal or long-term causal claims.",
        bullets: [
          "Observed pattern: upward.",
          "Causal explanation: not established by the CSV.",
        ],
        speakerNotes: "",
        requirementIds: ["R1"],
        layout: "standard",
      },
      {
        heading: "Limitations",
        body:
          "Only four monthly observations are available, with no explanatory variables or uncertainty estimates.",
        bullets: [
          "Small sample.",
          "No causal variables.",
          "No missing rows in the fixture.",
        ],
        speakerNotes: "",
        requirementIds: ["R1"],
        layout: "standard",
      },
    ],
    pages: undefined,
    sources: [
      source(
        "Recorded fixture CSV",
        "https://example.com/agent-diaz-golden-csv",
      ),
    ],
  },
};

export const threePageWebsiteGolden: ArtifactGoldenCase = {
  id: "three-page-website",
  kind: "website",
  prompt:
    "Create a three-page website explaining Vancouver public-space design with real photos and one discussion activity.",
  plan: {
    title: "Public Space Field Guide",
    subtitle: "How people move, meet and pause in Vancouver",
    requirements: [
      {
        id: "R1",
        text: "Create an exact three-page information website about Vancouver public-space design",
        mandatory: true,
      },
      {
        id: "R2",
        text: "Include one discussion activity",
        mandatory: true,
      },
    ],
    sections: [
      {
        heading: "What public space does",
        body:
          "Public spaces support movement, rest, social contact and access to nearby destinations.",
        bullets: [
          "Movement and accessibility.",
          "Seating and pause points.",
          "Connections to shops, transit and community uses.",
        ],
        speakerNotes: "",
        requirementIds: ["R1"],
        layout: "standard",
        imageQuery: "Vancouver public plaza people",
      },
      {
        heading: "Streets as places",
        body:
          "A street can function as both a transportation route and a place to stop, meet or participate in local activity.",
        bullets: [
          "Sidewalk width changes what can happen.",
          "Trees and shelter affect comfort.",
        ],
        speakerNotes: "",
        requirementIds: ["R1"],
        layout: "standard",
        imageQuery: "Vancouver pedestrian street public space",
      },
      {
        heading: "Parks and edges",
        body:
          "Park edges connect green space to sidewalks, neighbourhoods and nearby services.",
        bullets: [
          "Entrances make access legible.",
          "Edges can invite or discourage stopping.",
        ],
        speakerNotes: "",
        requirementIds: ["R1"],
        layout: "standard",
        imageQuery: "Vancouver city park people",
      },
      {
        heading: "Transit and gathering",
        body:
          "Transit stops often overlap with waiting, wayfinding and informal gathering.",
        bullets: [
          "Shelter and visibility matter.",
          "Clear paths help different users share the space.",
        ],
        speakerNotes: "",
        requirementIds: ["R1"],
        layout: "standard",
        imageQuery: "Vancouver transit public space people",
      },
      {
        heading: "Discuss the design",
        body:
          "Use one photographed place to identify a design choice, the behaviour it supports and one question you would investigate on site.",
        bullets: [],
        speakerNotes: "",
        requirementIds: ["R1", "R2"],
        layout: "standard",
        activity: {
          type: "discussion",
          durationMinutes: 8,
          directions: [
            "Choose one place from the site.",
            "Name one design feature.",
            "Explain what behaviour it may support and ask one follow-up question.",
          ],
          prompts: [
            "What do you notice first?",
            "Who can use this space comfortably?",
          ],
          sentenceFrames: [
            "The design feature ___ may support ___.",
            "I would investigate ___.",
          ],
          cornerLabels: [],
        },
      },
    ],
    pages: [
      {
        slug: "index",
        title: "Overview",
        description: "What public space does and how streets can become places.",
        sectionHeadings: ["What public space does", "Streets as places"],
      },
      {
        slug: "examples",
        title: "Examples",
        description: "Parks, transit and everyday gathering.",
        sectionHeadings: ["Parks and edges", "Transit and gathering"],
      },
      {
        slug: "discussion",
        title: "Discussion",
        description: "Apply the field-guide ideas to one place.",
        sectionHeadings: ["Discuss the design"],
      },
    ],
    sources: [
      source("City of Vancouver", "https://vancouver.ca/"),
      source("TransLink", "https://www.translink.ca/"),
      source("Vancouver Park Board", "https://vancouver.ca/parks-recreation-culture.aspx"),
    ],
  },
};

export const artifactGoldenCases: ArtifactGoldenCase[] = [
  frenchPresentTenseGolden,
  spanishCultureDocumentGolden,
  csvAnalysisGolden,
  threePageWebsiteGolden,
];

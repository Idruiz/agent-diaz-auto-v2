import type { JobKind } from "../shared/contracts.js";

export const TEACHING_CONTENT_RESEARCH_INSTRUCTION =
  "Research the *content* the students will encounter (cultural facts, authentic examples, places, foods, customs, sample sentences, image-worthy subjects with their real locations) and 3–5 credible sources for that content. Do not research pedagogy policy or curriculum documents unless the user asks for them.";

const TEACHING_REQUEST_RE =
  /\b(?:teach|teaching|lesson|students?|classroom|speed[\s-]*dating|(?:four|4)[\s-]*corners|exit[\s-]*ticket|worksheet|learning\s+(?:objective|activity)|grade\s*\d{1,2})\b/i;

export function evidenceSteeringForPrompt(prompt:string):string {
  return TEACHING_REQUEST_RE.test(prompt)
    ? TEACHING_CONTENT_RESEARCH_INSTRUCTION
    : "";
}

export interface AgentSkill {
  id:string;
  kind:JobKind;
  name:string;
  description:string;
  tools:Array<"web_search"|"python"|"mcp">;
  artifact:"none"|"docx"|"pptx"|"website_zip";
  minVisuals:number;
  instructions:string;
  validation:string[];
  approvalPolicy:"read_only"|"external_writes";
}

export const skills:AgentSkill[]=[
 {id:"conversation",kind:"chat",name:"Collaborative Chat & Actions",description:"Reason, plan, edit and—when configured—request approval for MCP actions.",tools:["mcp"],artifact:"none",minVisuals:0,approvalPolicy:"external_writes",validation:["Answer resolves the request","Uncertainty is explicit","External actions have tool receipts"],instructions:"Answer directly. Use the configured MCP only when it materially serves an explicit user request. Never perform an external write without approval and never claim success without a returned tool result."},
 {id:"deep-research",kind:"research",name:"Deep Research Report",description:"Research current evidence and deliver a cited visual Word report.",tools:["web_search"],artifact:"docx",minVisuals:3,approvalPolicy:"read_only",validation:["Material claims are cited","Sources are real URLs","At least three evidence-driven visuals","At least one relevant licensed photograph or explanatory illustration"],instructions:"Search iteratively until the core claims are supported. Resolve conflicts. Produce a publication-ready report with evidence tables, charts when the sources contain quantitative data, and specific licensed-image search briefs that materially clarify the subject."},
 {id:"data-analysis",kind:"analysis",name:"Data Analysis Lab",description:"Execute Python on uploaded files and deliver a visual analytical report.",tools:["python"],artifact:"docx",minVisuals:2,approvalPolicy:"read_only",validation:["All numbers derive from executed analysis","Methods and limitations are stated","At least two analytical tables or charts"],instructions:"Inspect every attached file with Python. Clean and validate the data, calculate findings, and create charts/tables only from executed results. Never infer unavailable values."},
 {id:"visual-presentation",kind:"presentation",name:"Visual Presentation",description:"Create a sourced PowerPoint with varied layouts, evidence charts, diagrams, notes and licensed imagery.",tools:["web_search"],artifact:"pptx",minVisuals:5,approvalPolicy:"read_only",validation:["Slide content is finished","At least half of content slides are genuinely visual","At least three slides use relevant licensed photography or explanatory illustration","Charts contain sourced data","Sources resolve","Speaker notes are useful"],instructions:"Plan a visual narrative, not a document chopped into slides. Give each slide one job. Use concise audience-facing copy, varied silhouettes, specific licensed-image search briefs, evidence charts rendered from exact plan data, exact tables, and at most the diagrams the story genuinely needs. Do not describe rendered chart graphics as editable native PowerPoint charts."},
 {id:"professional-document",kind:"document",name:"Professional Document",description:"Create a publication-ready, sourced and visual Word document.",tools:["web_search"],artifact:"docx",minVisuals:3,approvalPolicy:"read_only",validation:["Heading hierarchy is coherent","Tables and charts are evidence-based","At least one relevant licensed photograph or explanatory illustration","Sources resolve"],instructions:"Write finished prose with a coherent hierarchy. Use exact tables, evidence charts, relevant licensed imagery, and diagrams only where they materially clarify the argument."},
 {id:"multipage-website",kind:"website",name:"Multipage Website Studio",description:"Create a responsive multi-page website with licensed real photography and attribution.",tools:["web_search"],artifact:"website_zip",minVisuals:4,approvalPolicy:"read_only",validation:["At least three pages","Navigation works on every page","Images are local, licensed and attributed","No broken internal links","Responsive layout"],instructions:"Create a complete multi-page information website. Define 3-6 pages, a consistent navigation system, page-specific sections, and concrete real-photo search queries. Photos must be sourced from the configured licensed image provider, never generated by AI."}
];

export function getSkillForKind(kind:JobKind):AgentSkill {const s=skills.find(x=>x.kind===kind);if(!s)throw new Error(`No skill registered for ${kind}`);return s;}

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { PassThrough } from "node:stream";
import PptxGenModule from "pptxgenjs";
import { Document, Packer, Paragraph, TextRun, Footer, Header, PageNumber, AlignmentType, Table, TableRow, TableCell, WidthType, ImageRun, ShadingType, BorderStyle, VerticalAlign, TableLayoutType, LevelFormat } from "docx";
import archiver from "archiver";
import type { ArtifactPlan, JobKind } from "../shared/contracts.js";
import type { Config } from "./config.js";
import { atomicWrite, safeJoin } from "./files.js";
import { chartPng, chartSvg, diagramPng, diagramSvg } from "./visuals.js";
import {
  downloadCommonsCandidate,
  searchCommonsCandidates,
  type CommonsImageCandidate,
  type RealImage,
  type ImageProviderEvent,
} from "./real-images.js";
import {
  judgeImageCandidates,
  type ImageJudgeSection,
} from "./image-judge.js";
import { reconcilePresentationPlan } from "./reconcile.js";
import { compileArtifactPlan } from "./artifact-compiler.js";
import { planArtifactVisuals } from "./artifact-visual-plan.js";
import { presentationIdentityMarkers } from "./artifact-identity.js";
import { log } from "./log.js";
import {
  ArtifactPipelineError,
  estimatePptxEmptyCanvasRatio,
  validateBuiltArtifact,
  type ArtifactValidationReceipt,
} from "./artifact-quality.js";

const PptxGenJS=((PptxGenModule as any).default??PptxGenModule) as typeof PptxGenModule;

export interface BuiltFile { name:string; mime:string; path:string; size:number; validationReceipt:ArtifactValidationReceipt; }
export interface ArtifactBuildProgress {
  progress: number;
  stage: "visual-plan" | "image-search" | "image-judge" | "image-download" | "render" | "validate" | "package";
  message: string;
  current?: number;
  total?: number;
  completed?: number;
  found?: number;
}
export type ArtifactBuildProgressHandler = (event: ArtifactBuildProgress) => void;
const emitBuildProgress = (handler: ArtifactBuildProgressHandler | undefined, event: ArtifactBuildProgress) => handler?.(event);

const slug=(s:string)=>s.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g,"_").replace(/^_|_$/g,"").slice(0,80)||"artifact";
const escapeHtml=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export interface ImageResolutionReceipt {
  requested: number;
  fetched: number;
  judged: number;
  judgeCalls: number;
  rejectedWithReasons: Array<{
    sectionIndex: number;
    query: string;
    candidateId: string | null;
    title: string | null;
    reason: string;
  }>;
  placed: number;
}

export interface PresentationBuildReceipt {
  placedAssets: number;
  activityTemplates: string[];
  reconciliations: Array<{
    sectionIndex: number;
    heading: string;
    reason: string;
    movedToSpeakerNotes: string[];
  }>;
  titleCounts: {
    contentSlides: number;
    licensedVisuals: number;
  };
  layoutFitting: {
    retried: boolean;
    before: number[] | null;
    after: number[];
  };
}

export interface DocumentBuildReceipt {
  activitiesRendered: number;
  activityTypes: string[];
  truncations: Array<{
    section: string;
    field: string;
    originalCount: number;
    renderedCount: number;
  }>;
}

export interface WebsiteBuildReceipt {
  plannedPages: string[];
  renderedPages: number;
  sectionAssignments: number;
  uniqueImageFiles: number;
  sharedStylesheet: string;
  brokenInternalResources: number;
}

interface CollectedImages {
  images: Map<string, RealImage>;
  metrics: ImageResolutionReceipt;
}

const meaningfulWords = (value: string) =>
  value
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .slice(0, 7)
    .join(" ");

const inferAudience = (prompt: string) => {
  const grade = prompt.match(/\bgrade\s*(\d{1,2})\b/i);
  if (grade) return `Grade ${grade[1]} classroom`;
  if (/\b(?:teach|teaching|lesson|students?|classroom|practice)\b/i.test(prompt))
    return "school classroom audience";
  return "general audience";
};

async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  }));
  return results;
}

async function collectImages(
  config: Config,
  plan: ArtifactPlan,
  prompt = "",
  progress?: ArtifactBuildProgressHandler,
): Promise<CollectedImages> {
  const requests = plan.sections
    .map((section, sectionIndex) => ({ section, sectionIndex }))
    .filter(
      (item): item is {
        section: ArtifactPlan["sections"][number] & { imageQuery: string };
        sectionIndex: number;
      } => Boolean(item.section.imageQuery),
    );
  const rejectedWithReasons: ImageResolutionReceipt["rejectedWithReasons"] = [];
  const total = requests.length;
  let searchCompleted = 0;
  let fetched = 0;
  let downloadCompleted = 0;

  const providerEvent = (event: ImageProviderEvent) => {
    const seconds = Math.max(1, Math.ceil(event.waitMs / 1000));
    const message = event.type === "rate_limit" || event.type === "cooldown_wait"
      ? `Image provider rate-limited — waiting ${seconds}s · ${searchCompleted}/${total} searches complete · ${fetched} images ready`
      : `Image provider retrying in ${seconds}s · ${searchCompleted}/${total} searches complete`;
    emitBuildProgress(progress, {
      progress: 87,
      stage: "image-search",
      message,
      completed: searchCompleted,
      total,
      found: fetched,
    });
  };

  if (!total) {
    emitBuildProgress(progress, { progress: 88, stage: "image-search", message: "No external photographs required for this artifact", completed: 0, total: 0, found: 0 });
    return { images: new Map(), metrics: { requested: 0, fetched: 0, judged: 0, judgeCalls: 0, rejectedWithReasons, placed: 0 } };
  }

  emitBuildProgress(progress, { progress: 84, stage: "image-search", message: `Finding visuals: 0/${total} searches complete`, completed: 0, total, found: 0 });
  const judgeSections = await mapConcurrent(requests, 3, async ({ section, sectionIndex }, requestIndex) => {
    const query = section.imageQuery;
    emitBuildProgress(progress, {
      progress: 84 + Math.min(3, Math.floor((searchCompleted / Math.max(1, total)) * 4)),
      stage: "image-search",
      message: `Finding visual ${requestIndex + 1} of ${total}: ${section.heading}`,
      current: requestIndex + 1,
      total,
      completed: searchCompleted,
      found: fetched,
    });
    const candidateMap = new Map<string, CommonsImageCandidate>();
    const searchQueries = [query, section.heading, [section.heading, meaningfulWords(section.body)].filter(Boolean).join(" ")].filter(
      (value, index, all) => Boolean(value.trim()) && all.findIndex((candidate) => candidate.toLocaleLowerCase() === value.toLocaleLowerCase()) === index,
    );
    for (const searchQuery of searchQueries) {
      if (candidateMap.size >= 8) break;
      try {
        const result = await searchCommonsCandidates(searchQuery, 8 - candidateMap.size, { onEvent: providerEvent });
        for (const candidate of result.candidates) if (!candidateMap.has(candidate.id)) candidateMap.set(candidate.id, candidate);
        for (const rejected of result.rejected) rejectedWithReasons.push({ sectionIndex, query, candidateId: rejected.candidateId, title: rejected.title, reason: rejected.reason });
      } catch (error) {
        rejectedWithReasons.push({ sectionIndex, query, candidateId: null, title: null, reason: `Candidate search failed for '${searchQuery}': ${error instanceof Error ? error.message : String(error)}` });
      }
      if (candidateMap.size >= 4) break;
    }
    searchCompleted++;
    emitBuildProgress(progress, {
      progress: 84 + Math.min(4, Math.floor((searchCompleted / Math.max(1, total)) * 4)),
      stage: "image-search",
      message: `Finding visuals: ${searchCompleted}/${total} searches complete · ${candidateMap.size} candidates for ${section.heading}`,
      current: requestIndex + 1,
      total,
      completed: searchCompleted,
      found: fetched,
    });
    return { sectionIndex, heading: section.heading, body: section.body, audience: inferAudience(prompt), query, candidates: [...candidateMap.values()].slice(0, 8) } satisfies ImageJudgeSection;
  });

  emitBuildProgress(progress, { progress: 89, stage: "image-judge", message: `Judging relevance for ${total} visual slots`, completed: 0, total, found: fetched });
  const judged = await judgeImageCandidates(config, judgeSections, {
    onProviderEvent: providerEvent,
    onProgress: (message, completed, judgeTotal) => emitBuildProgress(progress, {
      progress: 89 + Math.min(2, Math.floor((completed / Math.max(1, judgeTotal)) * 2)),
      stage: "image-judge",
      message: `${message} · ${fetched} images ready`,
      completed,
      total: judgeTotal,
      found: fetched,
    }),
  });

  const images = new Map<string, RealImage>();
  await mapConcurrent(judgeSections, 3, async (section, sectionPosition) => {
    const decision = judged.decisions.find((item) => item.sectionIndex === section.sectionIndex);
    const chosen = decision?.chosenCandidate
      ? section.candidates.find((candidate) => candidate.id === decision.chosenCandidate)
      : undefined;
    if (!chosen) {
      for (const candidate of section.candidates) rejectedWithReasons.push({
        sectionIndex: section.sectionIndex,
        query: section.query,
        candidateId: candidate.id,
        title: candidate.title,
        reason: decision?.reason ? `Not selected by image judge: ${decision.reason}` : "Not selected by image judge.",
      });
      rejectedWithReasons.push({ sectionIndex: section.sectionIndex, query: section.query, candidateId: null, title: null, reason: decision?.reason || "No candidate met the qualitative relevance bar." });
      downloadCompleted++;
      emitBuildProgress(progress, { progress: 92 + Math.min(2, Math.floor((downloadCompleted / Math.max(1, total)) * 2)), stage: "image-download", message: `Visual ${sectionPosition + 1}/${total} unresolved · ${fetched} images ready`, current: sectionPosition + 1, total, completed: downloadCompleted, found: fetched });
      return;
    }

    emitBuildProgress(progress, { progress: 92, stage: "image-download", message: `Downloading visual ${sectionPosition + 1} of ${total}: ${section.heading}`, current: sectionPosition + 1, total, completed: downloadCompleted, found: fetched });
    const downloadOrder = [chosen, ...section.candidates.filter((candidate) => candidate.id !== chosen.id)];
    const failedIds = new Set<string>();
    let selected: CommonsImageCandidate | undefined;
    for (const candidate of downloadOrder) {
      try {
        const image = await downloadCommonsCandidate(candidate, { onEvent: providerEvent });
        images.set(section.query, image);
        fetched++;
        selected = candidate;
        log("info", candidate.id === chosen.id ? "artifact.image_judged_retrieved" : "artifact.image_fallback_retrieved", {
          query: section.query,
          sectionIndex: section.sectionIndex,
          candidateId: candidate.id,
          title: candidate.title,
          primaryCandidateId: chosen.id,
        });
        break;
      } catch (error) {
        failedIds.add(candidate.id);
        rejectedWithReasons.push({ sectionIndex: section.sectionIndex, query: section.query, candidateId: candidate.id, title: candidate.title, reason: `Candidate download failed: ${error instanceof Error ? error.message : String(error)}` });
        log("warn", "artifact.image_candidate_download_failed", { query: section.query, sectionIndex: section.sectionIndex, candidateId: candidate.id, primaryCandidateId: chosen.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const candidate of section.candidates) {
      if (candidate.id === selected?.id || failedIds.has(candidate.id)) continue;
      rejectedWithReasons.push({ sectionIndex: section.sectionIndex, query: section.query, candidateId: candidate.id, title: candidate.title, reason: selected ? `Not used after successfully retrieving '${selected.title}'.` : "Not selected by image judge." });
    }
    if (!selected) rejectedWithReasons.push({ sectionIndex: section.sectionIndex, query: section.query, candidateId: null, title: null, reason: "All judged image candidates failed download." });
    downloadCompleted++;
    emitBuildProgress(progress, {
      progress: 92 + Math.min(2, Math.floor((downloadCompleted / Math.max(1, total)) * 2)),
      stage: "image-download",
      message: `Images ready: ${fetched}/${total} · processed ${downloadCompleted}/${total}`,
      current: sectionPosition + 1,
      total,
      completed: downloadCompleted,
      found: fetched,
    });
  });

  return { images, metrics: { requested: requests.length, fetched, judged: judgeSections.length, judgeCalls: judged.judgeCalls, rejectedWithReasons, placed: 0 } };
}

const imageDataUri=(image:RealImage)=>`data:${image.mime};base64,${image.bytes.toString("base64")}`;
const isSourcesHeading=(heading:string)=>/^(sources|references|bibliography|works cited)$/i.test(heading.trim());
const short=(value:string,max:number)=>value.length<=max?value:`${value.slice(0,Math.max(1,max-1)).trimEnd()}…`;

type PptxTextValue = string | Array<{ text: string; options?: Record<string, unknown> }>;

function textValue(value: PptxTextValue): string {
  if (typeof value === "string") return value;
  return value
    .map((run) => `${run.text}${run.options?.breakLine ? "\n" : ""}`)
    .join("");
}

function estimatedTextHeight(
  value: PptxTextValue,
  width: number,
  fontSize: number,
  margin: number,
  lineHeight = 1.2,
): number {
  const charsPerLine = Math.max(
    8,
    Math.floor((Math.max(0.2, width - margin * 2) * 72) / (fontSize * 0.54)),
  );
  const lines = textValue(value)
    .split("\n")
    .reduce(
      (total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)),
      0,
    );
  return lines * ((fontSize * lineHeight) / 72) + margin * 2;
}

function addModelText(
  slide: any,
  value: PptxTextValue,
  options: Record<string, any>,
  bounds: { minHeight?: number; maxHeight?: number; lineHeight?: number } = {},
): void {
  const fontSize = Number(options.fontSize ?? 18);
  const margin = typeof options.margin === "number" ? options.margin : 0.08;
  const estimated = estimatedTextHeight(
    value,
    Number(options.w),
    fontSize,
    margin,
    bounds.lineHeight,
  );
  const maxHeight = bounds.maxHeight ?? Number(options.h ?? estimated);
  const minHeight = bounds.minHeight ?? Math.min(maxHeight, 0.18);
  slide.addText(value, {
    ...options,
    h: Math.max(minHeight, Math.min(maxHeight, estimated)),
    fit: "shrink",
  });
}

function noteParagraphs(
  notes: string | undefined,
  sources: string[],
): string[] {
  const paragraphs = (notes ?? "")
    .split(/\n+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (sources.length) {
    paragraphs.push("[Sources]");
    paragraphs.push(...sources.map((source) => `- ${source}`));
  }
  return paragraphs;
}

function addNotesParagraphs(slide: any, paragraphs: string[]): void {
  const clean = paragraphs.map((paragraph) => paragraph.trim()).filter(Boolean);
  if (clean.length) slide.addNotes(clean.join("\r\n\r\n"));
}

async function pptx(config:Config,plan:ArtifactPlan,prompt="",jobId="",progress?:ArtifactBuildProgressHandler):Promise<BuiltFile>{
  const originalContentSections=plan.sections.filter(section=>!isSourcesHeading(section.heading));
  const collectedImages=await collectImages(
    config,
    {...plan,sections:originalContentSections},
    prompt,
    progress,
  );
  const images=collectedImages.images;
  const reconciled=reconcilePresentationPlan(
    {...plan,sections:originalContentSections},
    new Set(images.keys()),
  );
  const contentSections=reconciled.plan.sections;
  const sourceChunks=plan.sources.length
    ?Array.from({length:Math.ceil(plan.sources.length/8)},(_,index)=>plan.sources.slice(index*8,index*8+8))
    :[];
  const name=`${slug(plan.title)}.pptx`,target=safeJoin(config.artifactDir,name);
  const renderAttempt=async(scaled:boolean)=>{
    const placedImageQueries=new Set<string>();
    const usedActivityTemplates=new Set<string>();
    const contentSlideNumbers:number[]=[];
    const p=new PptxGenJS();
    p.layout="LAYOUT_WIDE";
    p.author="Agent Díaz";
    p.subject=plan.title;
    p.title=plan.title;
    p.theme={headFontFace:"Aptos Display",bodyFontFace:"Aptos"};
    const bg="F7F3EA",ink="17202A",gold="C99A2E",navy="17324D",blue="2F739C",muted="5A6772",white="FFFFFF",pale="E7EEF2";
    let slideNumber=0;

    const addFooter=(slide:any,index:number)=>{
      slide.addShape(p.ShapeType.line,{x:.72,y:7.02,w:11.9,h:0,line:{color:"D5CEC0",pt:.6}});
      slide.addText("AGENT DÍAZ",{x:.75,y:7.09,w:1.6,h:.18,fontSize:8,bold:true,charSpacing:1.4,color:muted,margin:0});
      slide.addText(String(index).padStart(2,"0"),{x:11.95,y:7.06,w:.62,h:.22,fontSize:9,bold:true,color:muted,align:"right",margin:0});
    };
    const addHeading=(slide:any,heading:string,kicker?:string)=>{
      if(kicker)slide.addText(kicker.toUpperCase(),{x:.72,y:.34,w:2.2,h:.22,fontSize:9,bold:true,charSpacing:1.5,color:gold,margin:0});
      addModelText(slide,short(heading,92),{x:.72,y:.62,w:11.8,fontSize:28,bold:true,color:navy,margin:0,breakLine:false},{minHeight:.38,maxHeight:.72});
    };
    const addContentShell=(slide:any,heading:string,kicker:string)=>{
      slideNumber++;
      contentSlideNumbers.push(slideNumber);
      slide.background={color:bg};
      slide.addShape(p.ShapeType.rect,{x:0,y:0,w:13.333,h:.1,fill:{color:gold},line:{color:gold}});
      addHeading(slide,heading,kicker);
      if(scaled)slide.addShape(p.ShapeType.roundRect,{x:.75,y:1.5,w:11.85,h:5.3,rectRadius:.04,fill:{color:white},line:{color:"E4DED2",pt:.5}});
    };
    const addNarrative=(slide:any,section:ArtifactPlan["sections"][number],box:{x:number;y:number;w:number;h:number},dark=false)=>{
      const color=dark?white:ink,secondary=dark?"E8EEF3":muted;
      const bodyValue=short(section.body,460),hasBody=Boolean(section.body.trim());
      const bodyMax=hasBody?(section.bullets.length?Math.min(1.55,box.h*.36):box.h):0;
      if(hasBody)addModelText(slide,bodyValue,{x:box.x,y:box.y,w:box.w,fontSize:section.bullets.length?18:24,bold:!section.bullets.length,color,margin:0,breakLine:false,valign:"mid"},{minHeight:.42,maxHeight:bodyMax});
      if(section.bullets.length){
        const runs=section.bullets.slice(0,5).map((text,index)=>({text:short(text,180),options:{bullet:{indent:18},breakLine:index<section.bullets.slice(0,5).length-1}})),bulletOffset=hasBody?bodyMax+.16:0;
        addModelText(slide,runs,{x:box.x,y:box.y+bulletOffset,w:box.w,fontSize:17,color:secondary,margin:0,paraSpaceAfter:9,breakLine:false,valign:"top"},{minHeight:.75,maxHeight:Math.max(.75,box.h-bulletOffset)});
      }
    };
    const addPhoto=(slide:any,image:RealImage,box:{x:number;y:number;w:number;h:number})=>{
      slide.addShape(p.ShapeType.roundRect,{x:box.x-.04,y:box.y-.04,w:box.w+.08,h:box.h+.08,rectRadius:.08,fill:{color:white},line:{color:white},shadow:{type:"outer",color:"000000",opacity:.16,blur:2,angle:45,distance:1}});
      slide.addImage({data:imageDataUri(image),x:box.x,y:box.y,w:box.w,h:box.h,sizing:{type:"cover",w:box.w,h:box.h},altText:image.title});
    };
    const placePhoto=(slide:any,section:ArtifactPlan["sections"][number],image:RealImage,box:{x:number;y:number;w:number;h:number},captionBox?:{x:number;y:number;w:number;h:number})=>{
      addPhoto(slide,image,box);
      if(section.imageQuery)placedImageQueries.add(section.imageQuery);
      const caption=captionBox??{x:box.x,y:box.y+box.h+.08,w:box.w,h:.18};
      addModelText(slide,short(`${image.title} · ${image.creator} · ${image.license}`,180),{x:caption.x,y:caption.y,w:caption.w,fontSize:6.6,color:muted,margin:0,align:"right"},{minHeight:.1,maxHeight:caption.h});
    };
    const addStructuredPhoto=(slide:any,section:ArtifactPlan["sections"][number],image?:RealImage)=>{
      if(!image)return;
      placePhoto(slide,section,image,{x:10.18,y:2.02,w:2.25,h:3.55},{x:10.18,y:5.68,w:2.25,h:.25});
    };
    const addRenderedChart=async(slide:any,section:ArtifactPlan["sections"][number],image?:RealImage)=>{
      const chart=section.chart!,png=await chartPng(chart),visualW=image?9.08:11.85;
      addModelText(slide,short(chart.title,120),{x:.75,y:1.5,w:visualW,fontSize:18,bold:true,color:navy,margin:0},{minHeight:.3,maxHeight:.5});
      slide.addImage({data:`data:image/png;base64,${png.toString("base64")}`,x:.75,y:2.02,w:visualW,h:4.45,altText:chart.title});
      if(image)addStructuredPhoto(slide,section,image);
      if(chart.sourceNote)addModelText(slide,short(chart.sourceNote,180),{x:.78,y:6.5,w:visualW,fontSize:8,color:muted,margin:0},{minHeight:.12,maxHeight:.24});
    };
    const addNativeDiagram=(slide:any,section:ArtifactPlan["sections"][number],image?:RealImage)=>{
      const diagram=section.diagram!,nodes=diagram.nodes.slice(0,8),availableW=image?9.08:11.85;
      const longest=Math.max(0,...nodes.map(node=>node.length));
      const columns=nodes.length<=4&&longest<=28?Math.max(1,nodes.length):longest>52?Math.min(2,nodes.length):Math.min(3,nodes.length);
      const rows=Math.ceil(nodes.length/columns),gapX=.24,gapY=.25,boxW=(availableW-(columns-1)*gapX)/columns;
      const fontSize=longest>62?11.5:longest>38?12.5:13.5;
      const rawHeights=Array.from({length:rows},()=>.82);
      nodes.forEach((node,index)=>{
        const row=Math.floor(index/columns);
        rawHeights[row]=Math.max(rawHeights[row]!,estimatedTextHeight(node,boxW-.28,fontSize,.04,1.12)+.2);
      });
      const availableH=3.65,totalRaw=rawHeights.reduce((sum,value)=>sum+value,0)+(rows-1)*gapY;
      const scale=Math.min(1,availableH/Math.max(.1,totalRaw));
      const rowHeights=rawHeights.map(value=>Math.max(.72,value*scale));
      const rowY:number[]=[];let cursorY=2.0;
      rowHeights.forEach(height=>{rowY.push(cursorY);cursorY+=height+gapY;});
      const boxes=nodes.map((node,index)=>{const row=Math.floor(index/columns),col=index%columns;return{node,row,col,x:.75+col*(boxW+gapX),y:rowY[row]!,w:boxW,h:rowHeights[row]!};});
      addModelText(slide,short(diagram.title,120),{x:.75,y:1.5,w:availableW,fontSize:18,bold:true,color:navy,align:"center",margin:0},{minHeight:.3,maxHeight:.5});
      boxes.forEach((box,index)=>{
        slide.addShape(p.ShapeType.roundRect,{x:box.x,y:box.y,w:box.w,h:box.h,rectRadius:.05,fill:{color:index%2?pale:"F1E5C5"},line:{color:gold,pt:1.2},shadow:{type:"outer",color:"000000",opacity:.08,blur:1,angle:45,distance:.4}});
        addModelText(slide,box.node,{x:box.x+.14,y:box.y+.08,w:box.w-.28,fontSize,bold:true,color:navy,align:"center",valign:"mid",margin:.04,breakLine:false},{minHeight:.28,maxHeight:box.h-.16,lineHeight:1.12});
      });
      for(let index=0;index<boxes.length-1;index++){
        const current=boxes[index]!,next=boxes[index+1]!;
        if(current.row===next.row){
          slide.addShape(p.ShapeType.line,{x:current.x+current.w,y:current.y+current.h/2,w:Math.max(.05,next.x-(current.x+current.w)),h:0,line:{color:blue,pt:1.8,endArrowType:"triangle"}});
        }else{
          const startX=current.x+current.w/2,startY=current.y+current.h,endX=next.x+next.w/2,endY=next.y;
          const midY=startY+Math.max(.08,(endY-startY)/2);
          slide.addShape(p.ShapeType.line,{x:startX,y:startY,w:0,h:Math.max(.05,midY-startY),line:{color:blue,pt:1.6}});
          slide.addShape(p.ShapeType.line,{x:Math.min(startX,endX),y:midY,w:Math.abs(endX-startX),h:0,line:{color:blue,pt:1.6}});
          slide.addShape(p.ShapeType.line,{x:endX,y:midY,w:0,h:Math.max(.05,endY-midY),line:{color:blue,pt:1.6,endArrowType:"triangle"}});
        }
      }
      const captionY=Math.min(6.05,cursorY+.06);
      if(diagram.caption||section.body)addModelText(slide,short(diagram.caption||section.body,320),{x:.9,y:captionY,w:availableW-.3,fontSize:14,color:muted,align:"center",margin:0},{minHeight:.24,maxHeight:.62});
      if(image)addStructuredPhoto(slide,section,image);
    };
    const addNativeTable=(slide:any,section:ArtifactPlan["sections"][number],rows:string[][],chunkIndex:number,chunkCount:number,image?:RealImage)=>{
      const table=section.table!,visualW=image&&chunkIndex===0?9.08:11.85;
      const title=chunkCount>1?`${table.title} (${chunkIndex+1}/${chunkCount})`:table.title;
      addModelText(slide,short(title,140),{x:.75,y:1.5,w:visualW,fontSize:18,bold:true,color:navy,margin:0},{minHeight:.3,maxHeight:.5});
      const fontSize=rows.length<=4?18:rows.length<=6?16:14;
      const rowH=Math.max(.43,Math.min(.72,4.65/(rows.length+1)));
      const headers=table.headers.map(text=>({text:short(text,100),options:{bold:true,color:white,fill:{color:navy},margin:.08}}));
      const tableRows=rows.map((row,rowIndex)=>row.map(text=>({text:short(text,300),options:{fill:{color:rowIndex%2?"F2F5F6":white},color:ink,margin:.07}})));
      slide.addTable([headers,...tableRows],{x:.75,y:2.02,w:visualW,h:Math.max(3.18,rowH*(rows.length+1)),border:{type:"solid",color:"CCD4D9",pt:.7},fontFace:"Aptos",fontSize,rowH,margin:.06,valign:"middle",autoFit:false});
      if(image&&chunkIndex===0)addStructuredPhoto(slide,section,image);
    };
    const addActivitySlide=(slide:any,section:ArtifactPlan["sections"][number],image?:RealImage)=>{
      const activity=section.activity!;
      if(activity.type==="four_corners"){
        usedActivityTemplates.add("four-corners-quadrants");
        addModelText(slide,short(section.body,300),{x:.9,y:1.5,w:image?9.55:11.55,fontSize:19,bold:true,color:navy,align:"center",margin:0},{minHeight:.34,maxHeight:.62});
        if(activity.prompts[0])
          addModelText(slide,activity.prompts[0],{x:.95,y:2.14,w:11.42,fontSize:15,bold:true,color:blue,align:"center",margin:0},{minHeight:.24,maxHeight:.36});
        const labels=activity.cornerLabels.slice(0,4),colors=["F1E5C5","E7EEF2","E4EFE6","F3E4DF"];
        labels.forEach((label,index)=>{
          const column=index%2,row=Math.floor(index/2),x=.9+column*5.9,y=2.68+row*1.27;
          slide.addShape(p.ShapeType.roundRect,{x,y,w:5.62,h:1.22,rectRadius:.06,fill:{color:colors[index]!},line:{color:index%2?blue:gold,pt:1.4}});
          addModelText(slide,label,{x:x+.2,y:y+.16,w:5.22,fontSize:22,bold:true,color:navy,align:"center",valign:"mid",margin:.04},{minHeight:.38,maxHeight:.9});
        });
        const directions=activity.directions.map((text,index)=>({text:`${index+1}. ${short(text,180)}`,options:{breakLine:index<activity.directions.length-1}}));
        if(directions.length)addModelText(slide,directions,{x:.92,y:5.35,w:7.35,fontSize:13,color:ink,margin:.08},{minHeight:.42,maxHeight:1.15});
        if(activity.sentenceFrames.length){
          slide.addShape(p.ShapeType.roundRect,{x:8.52,y:5.26,w:3.9,h:1.18,rectRadius:.05,fill:{color:navy},line:{color:navy}});
          const frames=activity.sentenceFrames.slice(0,3).map((text,index)=>({text:short(text,180),options:{bullet:{indent:14},breakLine:index<Math.min(3,activity.sentenceFrames.length)-1}}));
          addModelText(slide,frames,{x:8.72,y:5.43,w:3.5,fontSize:12.5,bold:true,color:white,margin:.04},{minHeight:.32,maxHeight:.84});
        }
        if(image)placePhoto(slide,section,image,{x:10.72,y:1.48,w:1.68,h:.92},{x:10.72,y:2.43,w:1.68,h:.15});
        return;
      }
      if(activity.type==="speed_dating"){
        usedActivityTemplates.add("speed-dating-rotation");
        slide.addShape(p.ShapeType.roundRect,{x:.82,y:1.5,w:2.18,h:.72,rectRadius:.05,fill:{color:navy},line:{color:navy}});
        addModelText(slide,`${activity.durationMinutes} MIN · ROTATIONS`,{x:1.0,y:1.69,w:1.82,fontSize:15,bold:true,color:white,align:"center",valign:"mid",margin:0},{minHeight:.24,maxHeight:.34});
        const directions=activity.directions.slice(0,5).map((text,index)=>({text:`${index+1}. ${short(text,180)}`,options:{breakLine:index<Math.min(5,activity.directions.length)-1}}));
        if(directions.length)addModelText(slide,directions,{x:.86,y:2.38,w:11.62,fontSize:13.5,color:ink,margin:.06},{minHeight:.45,maxHeight:.78});
        const prompts=activity.prompts.slice(0,6),columns=prompts.length===2?2:Math.min(2,prompts.length),rows=Math.ceil(prompts.length/columns);
        const frameCount=Math.min(4,activity.sentenceFrames.length),frameFont=13,lineHeight=(frameFont*1.2)/72;
        const frameH=Math.max(.5,frameCount*lineHeight+.26),frameY=6.68-frameH;
        const gridTop=3.28,gridBottom=frameY-.18,gap=.2,cardH=(gridBottom-gridTop-(rows-1)*gap)/rows,cardW=(11.62-(columns-1)*.28)/columns;
        prompts.forEach((text,index)=>{
          const column=index%columns,row=Math.floor(index/columns),x=.86+column*(cardW+.28),y=gridTop+row*(cardH+gap);
          slide.addShape(p.ShapeType.roundRect,{x,y,w:cardW,h:cardH,rectRadius:.05,fill:{color:index%2?"EEF3F5":"F7EED7"},line:{color:index%2?blue:gold,pt:1}});
          const value:[{text:string;options:Record<string,unknown>},{text:string;options:Record<string,unknown>}]=[{text:String(index+1).padStart(2,"0"),options:{bold:true,color:gold,breakLine:true}},{text:short(text,250),options:{bold:true,color:navy}}];
          addModelText(slide,value,{x:x+.15,y:y+.12,w:cardW-.3,fontSize:14,margin:.04,valign:"mid"},{minHeight:.28,maxHeight:cardH-.24});
        });
        if(frameCount){
          slide.addShape(p.ShapeType.roundRect,{x:.86,y:frameY,w:image?9.05:11.62,h:frameH,rectRadius:.05,fill:{color:navy},line:{color:navy}});
          const frames=activity.sentenceFrames.slice(0,frameCount).map((text,index)=>({text:short(text,200),options:{bullet:{indent:14},breakLine:index<frameCount-1}}));
          addModelText(slide,frames,{x:1.06,y:frameY+.1,w:image?8.65:11.22,fontSize:frameFont,bold:true,color:white,margin:.04},{minHeight:.25,maxHeight:frameH-.2});
        }
        if(image)placePhoto(slide,section,image,{x:10.16,y:frameY,w:2.32,h:frameH},{x:10.16,y:6.7,w:2.32,h:.14});
        return;
      }

      const template=activity.type==="guided_practice"?"guided-step-rail":activity.type==="discussion"?"discussion-prompt-cards":"independent-checklist";
      usedActivityTemplates.add(template);
      addModelText(slide,short(section.body,360),{x:.9,y:1.5,w:11.5,fontSize:19,bold:true,color:navy,align:activity.type==="discussion"?"center":"left",margin:0},{minHeight:.34,maxHeight:.68});
      const directions=activity.directions.slice(0,6),prompts=activity.prompts.slice(0,6),hasDirections=directions.length>0;
      if(hasDirections){
        slide.addShape(p.ShapeType.roundRect,{x:.9,y:2.35,w:3.55,h:3.9,rectRadius:.06,fill:{color:pale},line:{color:blue,pt:1}});
        slide.addText("DIRECTIONS",{x:1.16,y:2.62,w:2.95,h:.25,fontSize:11,bold:true,charSpacing:1.4,color:blue,margin:0});
        const directionRuns=directions.map((text,index)=>({text:`${index+1}. ${short(text,160)}`,options:{breakLine:index<directions.length-1}}));
        addModelText(slide,directionRuns,{x:1.16,y:3.04,w:2.95,fontSize:13.5,color:ink,margin:.04},{minHeight:.5,maxHeight:2.85});
      }
      const promptW=image?(hasDirections?5.1:9.0):(hasDirections?7.6:11.55),promptX=hasDirections?4.72:.9,promptGap=.16,promptBottom=activity.sentenceFrames.length?5.72:6.25;
      const promptH=Math.max(.38,(promptBottom-2.35-(prompts.length-1)*promptGap)/Math.max(1,prompts.length));
      prompts.forEach((text,index)=>{
        const y=2.35+index*(promptH+promptGap);
        slide.addShape(p.ShapeType.roundRect,{x:promptX,y,w:promptW,h:promptH,rectRadius:.04,fill:{color:index%2?white:"F7EED7"},line:{color:index%2?"D6DEE3":gold,pt:.8}});
        addModelText(slide,short(text,240),{x:promptX+.16,y:y+.1,w:promptW-.32,fontSize:13.5,bold:true,color:navy,margin:.03,valign:"mid"},{minHeight:.24,maxHeight:promptH-.2});
      });
      if(activity.sentenceFrames.length){
        const frames=activity.sentenceFrames.slice(0,4).map((text,index)=>({text:short(text,180),options:{breakLine:index<Math.min(4,activity.sentenceFrames.length)-1}}));
        addModelText(slide,frames,{x:4.72,y:5.88,w:promptW,fontSize:12,bold:true,color:blue,margin:0},{minHeight:.25,maxHeight:.66});
      }
      if(image)placePhoto(slide,section,image,{x:10.12,y:2.35,w:2.3,h:3.2},{x:10.12,y:5.66,w:2.3,h:.18});
    };

    const title=p.addSlide();
    slideNumber++;
    title.background={color:navy};
    title.addShape(p.ShapeType.rect,{x:0,y:0,w:.18,h:7.5,fill:{color:gold},line:{color:gold}});
    title.addShape(p.ShapeType.arc,{x:9.15,y:.35,w:3.65,h:3.65,rotate:18,fill:{color:gold,transparency:78},line:{color:gold,transparency:100}});
    title.addText("VISUAL BRIEF",{x:.82,y:1.06,w:2.8,h:.24,fontSize:10,bold:true,charSpacing:2,color:gold,margin:0});
    addModelText(title,short(plan.title,160),{x:.82,y:1.55,w:10.6,fontFace:"Aptos Display",fontSize:42,bold:true,color:white,margin:0,breakLine:false,valign:"middle"},{minHeight:.7,maxHeight:1.65});
    if(plan.subtitle)addModelText(title,short(plan.subtitle,240),{x:.85,y:3.62,w:8.9,fontSize:20,color:"DDE6ED",margin:0},{minHeight:.34,maxHeight:.92});
    addNotesParagraphs(title,["Opening slide"]);

    for(const [index,section] of contentSections.entries()){
      const image=section.imageQuery?images.get(section.imageQuery):undefined;
      const tableChunks=section.table
        ?Array.from({length:Math.ceil(section.table.rows.length/8)},(_,chunkIndex)=>section.table!.rows.slice(chunkIndex*8,chunkIndex*8+8))
        :null;
      if(tableChunks){
        for(const [chunkIndex,rows] of tableChunks.entries()){
          const slide=p.addSlide();
          addContentShell(slide,section.heading,`Part ${String(index+1).padStart(2,"0")}`);
          addNativeTable(slide,section,rows,chunkIndex,tableChunks.length,chunkIndex===0?image:undefined);
          addFooter(slide,slideNumber);
          addNotesParagraphs(slide,[...noteParagraphs(section.speakerNotes,[...(chunkIndex===0&&image&&section.imageQuery?[image.sourceUrl]:[])]),...presentationIdentityMarkers(section,index)]);
        }
        continue;
      }

      const fullBleed=Boolean(image&&!section.activity&&!section.chart&&!section.diagram&&index%4===2);
      const slide=p.addSlide();
      slideNumber++;
      contentSlideNumbers.push(slideNumber);
      slide.background={color:bg};
      if(fullBleed&&image){
        slide.addImage({data:imageDataUri(image),x:0,y:0,w:13.333,h:7.5,sizing:{type:"cover",w:13.333,h:7.5},altText:image.title});
        if(section.imageQuery)placedImageQueries.add(section.imageQuery);
        slide.addShape(p.ShapeType.rect,{x:0,y:0,w:13.333,h:7.5,fill:{color:navy,transparency:22},line:{color:navy,transparency:100}});
        slide.addShape(p.ShapeType.rect,{x:.66,y:.66,w:6.15,h:5.62,fill:{color:navy,transparency:12},line:{color:white,transparency:100}});
        addModelText(slide,short(section.heading,92),{x:.98,y:1.05,w:5.55,fontSize:34,bold:true,color:white,margin:0},{minHeight:.52,maxHeight:1.05});
        addNarrative(slide,section,{x:1,y:2.3,w:5.3,h:3.35},true);
        addModelText(slide,short(`${image.title} · ${image.creator} · ${image.license}`,180),{x:7.05,y:6.76,w:5.5,fontSize:6.5,color:white,align:"right",margin:0},{minHeight:.1,maxHeight:.14});
      }else{
        slide.addShape(p.ShapeType.rect,{x:0,y:0,w:13.333,h:.1,fill:{color:gold},line:{color:gold}});
        addHeading(slide,section.heading,`Part ${String(index+1).padStart(2,"0")}`);
        if(scaled)slide.addShape(p.ShapeType.roundRect,{x:.75,y:1.5,w:11.85,h:5.3,rectRadius:.04,fill:{color:white},line:{color:"E4DED2",pt:.5}});
        if(section.activity)addActivitySlide(slide,section,image);
        else if(section.chart)await addRenderedChart(slide,section,image);
        else if(section.diagram)addNativeDiagram(slide,section,image);
        else if(image){
          const imageLeft=index%2===1;
          const imageBox={x:imageLeft ? .75 : 7.02,y:1.5,w:5.58,h:4.92};
          const textBox={x:imageLeft ? 6.72 : .78,y:1.66,w:5.45,h:4.7};
          placePhoto(slide,section,image,imageBox,{x:imageBox.x,y:6.5,w:imageBox.w,h:.2});
          addNarrative(slide,section,textBox);
        }else{
          slide.addText(String(index+1).padStart(2,"0"),{x:.76,y:1.55,w:2.1,h:1.3,fontSize:74,bold:true,color:"E4D7B3",margin:0});
          slide.addShape(p.ShapeType.line,{x:3.05,y:1.92,w:0,h:4.15,line:{color:gold,pt:2}});
          addNarrative(slide,section,{x:3.52,y:1.67,w:8.55,h:4.65});
        }
        addFooter(slide,slideNumber);
      }
      const noteSources=[...(image&&section.imageQuery&&placedImageQueries.has(section.imageQuery)?[image.sourceUrl]:[]),...(section.chart?.sourceNote?[section.chart.sourceNote]:[])];
      addNotesParagraphs(slide,[...noteParagraphs(section.speakerNotes,noteSources),...presentationIdentityMarkers(section,index)]);
    }

    const unplacedFetched=[...images.keys()].filter(query=>!placedImageQueries.has(query));
    if(unplacedFetched.length)throw new ArtifactPipelineError("BUILD",`Presentation layout discarded fetched images: ${unplacedFetched.join(", ")}`,{ruleOrPart:"pptx-image-placement"});
    addModelText(title,`${contentSlideNumbers.length} ideas · ${placedImageQueries.size} licensed visuals`,{x:.85,y:6.72,w:4.8,fontSize:9,bold:true,charSpacing:.8,color:"B9C8D3",margin:0},{minHeight:.14,maxHeight:.22});

    for(const [chunkIndex,chunk] of sourceChunks.entries()){
      const slide=p.addSlide();
      slideNumber++;
      slide.background={color:bg};
      slide.addShape(p.ShapeType.rect,{x:0,y:0,w:13.333,h:.1,fill:{color:gold},line:{color:gold}});
      addHeading(slide,sourceChunks.length>1?`Sources ${chunkIndex+1} of ${sourceChunks.length}`:"Sources","Evidence trail");
      chunk.forEach((source,index)=>{
        const y=1.48+index*.66;
        slide.addText(String(chunkIndex*8+index+1).padStart(2,"0"),{x:.78,y,w:.42,h:.23,fontSize:10,bold:true,color:gold,margin:0});
        addModelText(slide,short(source.title,180),{x:1.35,y:y-.02,w:4.15,fontSize:13,bold:true,color:navy,margin:0},{minHeight:.2,maxHeight:.32});
        addModelText(slide,short(source.url,150),{x:5.7,y:y-.02,w:6.45,fontSize:10,color:blue,margin:0,hyperlink:{url:source.url}},{minHeight:.18,maxHeight:.3});
      });
      addFooter(slide,slideNumber);
      addNotesParagraphs(slide,noteParagraphs("",chunk.map(source=>source.url)));
    }

    const raw=Buffer.from(await p.write({outputType:"nodebuffer"}) as ArrayBuffer);
    if(raw.length<5000)throw new ArtifactPipelineError("BUILD","PPTX validation failed: output too small",{ruleOrPart:"pptx-size"});
    atomicWrite(target,raw);
    return{raw,placedImageQueries,usedActivityTemplates,contentSlideNumbers};
  };

  emitBuildProgress(progress,{progress:95,stage:"render",message:`Rendering presentation · ${contentSections.length} content sections · ${images.size} photographs ready`,completed:images.size,total:collectedImages.metrics.requested,found:images.size});
  const rendered=await renderAttempt(false);
  const ratios=estimatePptxEmptyCanvasRatio(target).bySlide;
  collectedImages.metrics.placed=rendered.placedImageQueries.size;
  log("info", "artifact.image_summary", {
    kind:"presentation",
    requested:collectedImages.metrics.requested,
    judged:collectedImages.metrics.judged,
    fetched:collectedImages.metrics.fetched,
    placed:collectedImages.metrics.placed,
    unresolved:Math.max(0,collectedImages.metrics.requested-collectedImages.metrics.placed),
  });
  emitBuildProgress(progress,{progress:97,stage:"validate",message:"Checking PPTX package and desktop-render compatibility"});
  const validationReceipt=await validateBuiltArtifact(
    "presentation",
    prompt,
    reconciled.plan,
    target,
    jobId
      ?{root:path.join(config.storageRoot,"diagnostics"),jobId,presentationContentSlides:rendered.contentSlideNumbers}
      :{presentationContentSlides:rendered.contentSlideNumbers},
  );
  collectedImages.metrics.placed=rendered.placedImageQueries.size;
  const enrichedReceipt=validationReceipt as ArtifactValidationReceipt&{images:ImageResolutionReceipt;presentation:PresentationBuildReceipt};
  enrichedReceipt.images=collectedImages.metrics;
  enrichedReceipt.presentation={
    placedAssets:rendered.placedImageQueries.size,
    activityTemplates:[...rendered.usedActivityTemplates].sort(),
    reconciliations:reconciled.reconciliations,
    titleCounts:{contentSlides:rendered.contentSlideNumbers.length,licensedVisuals:rendered.placedImageQueries.size},
    layoutFitting:{retried:false,before:null,after:ratios},
  };
  emitBuildProgress(progress,{progress:99,stage:"package",message:"Presentation validated and ready for export"});
  return{name,mime:"application/vnd.openxmlformats-officedocument.presentationml.presentation",path:target,size:rendered.raw.length,validationReceipt};
}

async function docx(config:Config,plan:ArtifactPlan,prompt="",kind:Extract<JobKind,"document"|"analysis"|"research">="document",jobId="",progress?:ArtifactBuildProgressHandler):Promise<BuiltFile>{
  const contentSections=plan.sections.filter(section=>!isSourcesHeading(section.heading));
  const collectedImages=await collectImages(
    config,
    {...plan,sections:contentSections},
    prompt,
    progress,
  );
  const images=collectedImages.images;
  const placedImageQueries=new Set<string>();
  const noBorder={style:BorderStyle.NONE,size:0,color:"FFFFFF"};
  const cellBorders={top:noBorder,bottom:{style:BorderStyle.SINGLE,size:4,color:"D9E0E4"},left:noBorder,right:noBorder,insideHorizontal:noBorder,insideVertical:noBorder};
  const tableWidths=(headers:string[],rows:string[][])=>{
    const weights=headers.map((header,column)=>Math.min(44,Math.max(8,header.length,...rows.map(row=>(row[column]||"").length)))),minimum=720,remaining=9360-minimum*weights.length,total=weights.reduce((sum,value)=>sum+value,0),widths=weights.map(weight=>minimum+Math.floor(remaining*weight/total));
    widths[widths.length-1]!+=9360-widths.reduce((sum,value)=>sum+value,0);return widths;
  };
  const imageDimensions=(image:RealImage,maxWidth=560,maxHeight=320)=>{const scale=Math.min(maxWidth/image.width,maxHeight/image.height);return{width:Math.max(1,Math.round(image.width*scale)),height:Math.max(1,Math.round(image.height*scale))}};
  const documentTruncations:DocumentBuildReceipt["truncations"]=[];
  const renderedActivityTypes=new Set<string>();
  let activitiesRendered=0;
  let nextDrawingId=1;
  const drawingAltText=(name:string,description:string,title=name)=>({
    id:String(nextDrawingId++),
    name,
    description,
    title,
  });
  const addActivityToDocument=(section:ArtifactPlan["sections"][number])=>{
    const activity=section.activity;
    if(!activity)return;
    activitiesRendered++;
    renderedActivityTypes.add(activity.type);
    children.push(
      new Paragraph({spacing:{before:220,after:90},keepNext:true,children:[
        new TextRun({text:`Activity · ${activity.type.replace(/_/g," ")} · ${activity.durationMinutes} min`,bold:true,size:22,color:"C99A2E",allCaps:true}),
      ]}),
      new Paragraph({spacing:{after:80},children:[new TextRun({text:"Directions",bold:true,size:20,color:"17324D"})]}),
    );
    activity.directions.forEach((value,index)=>children.push(
      new Paragraph({spacing:{after:70},indent:{left:360,hanging:220},children:[
        new TextRun({text:`${index+1}. `,bold:true,size:18,color:"2F739C"}),
        new TextRun({text:value,size:18,color:"17202A"}),
      ]}),
    ));
    if(activity.type==="four_corners"){
      children.push(new Paragraph({spacing:{before:120,after:90},keepNext:true,children:[new TextRun({text:"Four Corners",bold:true,size:20,color:"17324D"})]}));
      const labels=[...activity.cornerLabels];
      const cells=Array.from({length:4},(_,index)=>new TableCell({
        width:{size:4680,type:WidthType.DXA},
        verticalAlign:VerticalAlign.CENTER,
        shading:{type:ShadingType.CLEAR,fill:index%2?"E7EEF2":"F7EED7",color:"auto"},
        borders:cellBorders,
        children:[new Paragraph({alignment:AlignmentType.CENTER,spacing:{before:180,after:180},children:[
          new TextRun({text:labels[index]??"",bold:true,size:22,color:"17324D"}),
        ]})],
      }));
      children.push(new Table({
        width:{size:9360,type:WidthType.DXA},
        columnWidths:[4680,4680],
        layout:TableLayoutType.FIXED,
        rows:[
          new TableRow({children:[cells[0]!,cells[1]!]}),
          new TableRow({children:[cells[2]!,cells[3]!]}),
        ],
        borders:cellBorders,
      }));
    }
    if(activity.prompts.length){
      children.push(new Paragraph({spacing:{before:140,after:80},keepNext:true,children:[new TextRun({text:"Prompts",bold:true,size:20,color:"17324D"})]}));
      activity.prompts.forEach((value)=>children.push(
        new Paragraph({text:value,numbering:{reference:"activity-prompts",level:0},style:"BodyText"}),
      ));
    }
    if(activity.sentenceFrames.length){
      children.push(new Paragraph({spacing:{before:140,after:80},keepNext:true,children:[new TextRun({text:"Sentence frames",bold:true,size:20,color:"17324D"})]}));
      activity.sentenceFrames.forEach((value)=>children.push(
        new Paragraph({spacing:{after:70},children:[new TextRun({text:value,italics:true,size:18,color:"2F739C"})]}),
      ));
    }
  };
  const children:Array<Paragraph|Table>=[
    new Paragraph({spacing:{before:1760,after:160},children:[new TextRun({text:plan.title,bold:true,size:60,color:"17324D",font:"Calibri"})],alignment:AlignmentType.CENTER}),
    new Paragraph({border:{bottom:{style:BorderStyle.SINGLE,size:18,color:"C99A2E",space:1}},spacing:{after:360}}),
    ...(plan.subtitle?[new Paragraph({spacing:{after:620},children:[new TextRun({text:plan.subtitle,italics:true,size:30,color:"5A6772",font:"Calibri"})],alignment:AlignmentType.CENTER})]:[]),
    new Paragraph({spacing:{before:460,after:80},children:[new TextRun({text:"Prepared by Agent Díaz",bold:true,size:18,color:"C99A2E",allCaps:true,characterSpacing:20})],alignment:AlignmentType.CENTER}),
    new Paragraph({spacing:{after:900},children:[new TextRun({text:new Date().toLocaleDateString("en-CA",{year:"numeric",month:"long",day:"numeric"}),size:18,color:"5A6772"})],alignment:AlignmentType.CENTER}),
    new Paragraph({pageBreakBefore:true,text:""}),
  ];
  for(const [index,section] of contentSections.entries()){
    const imageStartsPage=index>0&&!!section.imageQuery&&images.has(section.imageQuery);
    children.push(
      new Paragraph({pageBreakBefore:imageStartsPage,style:"DiazHeading1",keepNext:true,border:{bottom:{style:BorderStyle.SINGLE,size:8,color:"C99A2E",space:6}},children:[new TextRun({text:section.heading,bold:true,color:"2E74B5",size:32,font:"Calibri"})]}),
      new Paragraph({keepNext:true,children:[new TextRun({text:section.body,size:22,color:"17202A",font:"Calibri"})]}),
    );
    for(const bullet of section.bullets)children.push(new Paragraph({text:bullet,numbering:{reference:"artifact-bullets",level:0},style:"BodyText"}));
    if(section.table){
      const sourceRows=section.table.rows,widths=tableWidths(section.table.headers,sourceRows);
      children.push(new Paragraph({spacing:{before:80,after:80},children:[new TextRun({text:section.table.title,bold:true,size:23,color:"17324D"})]}));
      const header=new TableRow({tableHeader:true,children:section.table.headers.map((header,column)=>new TableCell({width:{size:widths[column]!,type:WidthType.DXA},shading:{type:ShadingType.CLEAR,fill:"F2F4F7",color:"auto"},verticalAlign:VerticalAlign.CENTER,borders:cellBorders,children:[new Paragraph({spacing:{before:70,after:70},children:[new TextRun({text:header,bold:true,color:"17324D",size:18})]})]}))});
      const rows=sourceRows.map(row=>new TableRow({children:row.map((value,column)=>new TableCell({width:{size:widths[column]!,type:WidthType.DXA},shading:{type:ShadingType.CLEAR,fill:"FFFFFF",color:"auto"},verticalAlign:VerticalAlign.CENTER,borders:cellBorders,children:[new Paragraph({spacing:{before:60,after:60},children:[new TextRun({text:value,size:17,color:"17202A"})]})]}))}));
      children.push(new Table({width:{size:9360,type:WidthType.DXA},indent:{size:120,type:WidthType.DXA},columnWidths:widths,margins:{top:80,bottom:80,left:120,right:120},layout:TableLayoutType.FIXED,rows:[header,...rows],borders:cellBorders}));
    }
    if(section.chart){
      const png=await chartPng(section.chart);
      children.push(new Paragraph({spacing:{before:180,after:80},children:[new ImageRun({data:png,transformation:{width:560,height:314},type:"png",altText:drawingAltText(section.chart.title,section.chart.sourceNote||section.chart.title)})],alignment:AlignmentType.CENTER}));
      if(section.chart.sourceNote)children.push(new Paragraph({spacing:{after:140},children:[new TextRun({text:`Source: ${section.chart.sourceNote}`,italics:true,size:16,color:"5A6772"})],alignment:AlignmentType.CENTER}));
    }else if(section.diagram){
      const png=await diagramPng(section.diagram);
      children.push(new Paragraph({spacing:{before:180,after:120},children:[new ImageRun({data:png,transformation:{width:560,height:235},type:"png",altText:drawingAltText(section.diagram.title,section.diagram.caption||section.diagram.title)})],alignment:AlignmentType.CENTER}));
    }else if(section.imageQuery&&images.has(section.imageQuery)){
      placedImageQueries.add(section.imageQuery);
      const image=images.get(section.imageQuery)!,dimensions=imageDimensions(image);
      children.push(
        new Paragraph({spacing:{before:220,after:80},children:[new ImageRun({data:image.bytes,transformation:dimensions,type:image.extension as "jpg"|"png",altText:drawingAltText(image.title,`${image.title} by ${image.creator}`)})],alignment:AlignmentType.CENTER}),
        new Paragraph({spacing:{after:140},children:[new TextRun({text:`${image.title} — ${image.creator} · ${image.license}`,italics:true,size:15,color:"5A6772"})],alignment:AlignmentType.CENTER}),
      );
    }
    addActivityToDocument(section);
  }
  if(plan.sources.length){
    children.push(new Paragraph({pageBreakBefore:true,style:"DiazHeading1",children:[new TextRun({text:"Sources",bold:true,color:"17324D",size:34})]}));
    plan.sources.forEach((source,index)=>children.push(new Paragraph({spacing:{after:110},indent:{left:360,hanging:360},children:[new TextRun({text:`${index+1}. ${source.title}. `,bold:true,size:17,color:"17324D"}),new TextRun({text:source.url,size:16,color:"2F739C"})]})));
  }
  const d=new Document({
    creator:"Agent Díaz",title:plan.title,description:plan.subtitle,
    styles:{
      default:{document:{run:{font:"Calibri",size:22,color:"17202A"},paragraph:{spacing:{after:120,line:264}}}},
      paragraphStyles:[
        {id:"DiazHeading1",name:"Diaz Heading 1",basedOn:"Normal",next:"Normal",quickFormat:true,run:{font:"Calibri",size:32,bold:true,color:"2E74B5"},paragraph:{spacing:{before:320,after:160},outlineLevel:0,keepNext:true}},
        {id:"BodyText",name:"Body Text",basedOn:"Normal",quickFormat:true,run:{font:"Calibri",size:22,color:"17202A"},paragraph:{spacing:{after:160,line:280}}},
      ],
    },
    numbering:{config:[
      {reference:"artifact-bullets",levels:[{level:0,format:LevelFormat.BULLET,text:"•",alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:720,hanging:360},spacing:{after:160,line:280}},run:{font:"Calibri",size:22,color:"17202A"}}}]},
      {reference:"activity-prompts",levels:[{level:0,format:LevelFormat.BULLET,text:"◆",alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:720,hanging:360},spacing:{after:120,line:260}},run:{font:"Calibri",size:20,color:"17324D"}}}]},
    ]},
    sections:[{properties:{titlePage:true,page:{margin:{top:1440,right:1440,bottom:1440,left:1440,header:708,footer:708}}},headers:{first:new Header({children:[new Paragraph("")]}),default:new Header({children:[new Paragraph({border:{bottom:{style:BorderStyle.SINGLE,size:5,color:"D9E0E4",space:4}},children:[new TextRun({text:short(plan.title,85),bold:true,size:16,color:"5A6772",font:"Calibri"})]})]})},footers:{first:new Footer({children:[new Paragraph("")]}),default:new Footer({children:[new Paragraph({border:{top:{style:BorderStyle.SINGLE,size:5,color:"D9E0E4",space:4}},children:[new TextRun({text:"AGENT DÍAZ  ·  ",bold:true,size:14,color:"C99A2E",font:"Calibri"}),new TextRun({children:[PageNumber.CURRENT],size:14,color:"5A6772",font:"Calibri"})],alignment:AlignmentType.RIGHT})]})},children}],
  });
  const buf=await Packer.toBuffer(d); if(buf.length<3000)throw new Error("DOCX validation failed: output too small");
  const name=`${slug(plan.title)}.docx`,target=safeJoin(config.artifactDir,name);
  atomicWrite(target,buf);
  collectedImages.metrics.placed=placedImageQueries.size;
  log("info", "artifact.image_summary", {
    kind,
    requested:collectedImages.metrics.requested,
    judged:collectedImages.metrics.judged,
    fetched:collectedImages.metrics.fetched,
    placed:collectedImages.metrics.placed,
    unresolved:Math.max(0,collectedImages.metrics.requested-collectedImages.metrics.placed),
  });
  const validationReceipt=await validateBuiltArtifact(
    kind,
    prompt,
    plan,
    target,
    jobId ? { root: path.join(config.storageRoot, "diagnostics"), jobId } : undefined,
  );
  collectedImages.metrics.placed=placedImageQueries.size;
  const enrichedReceipt=validationReceipt as ArtifactValidationReceipt & {
    images:ImageResolutionReceipt;
    document:DocumentBuildReceipt;
  };
  enrichedReceipt.images=collectedImages.metrics;
  enrichedReceipt.document={
    activitiesRendered,
    activityTypes:[...renderedActivityTypes].sort(),
    truncations:documentTruncations,
  };
  return{name,mime:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",path:target,size:buf.length,validationReceipt};
}

async function website(
  config:Config,
  plan:ArtifactPlan,
  prompt="",
  jobId="",
  progress?:ArtifactBuildProgressHandler,
):Promise<BuiltFile>{
  const contentSections=plan.sections.filter(
    section=>!isSourcesHeading(section.heading),
  );
  const pages=plan.pages;
  if(!pages||pages.length<3)
    throw new ArtifactPipelineError(
      "PLAN_CONTENT",
      "Website build requires at least three fully specified plan.pages entries.",
      {ruleOrPart:"website-pages"},
    );

  const sectionByHeading=new Map(
    contentSections.map(section=>[section.heading,section] as const),
  );
  const assignmentCounts=new Map<string,number>();
  for(const page of pages){
    for(const heading of page.sectionHeadings){
      if(!sectionByHeading.has(heading))
        throw new ArtifactPipelineError(
          "PLAN_CONTENT",
          `Website page '${page.slug}' references unknown section '${heading}'.`,
          {ruleOrPart:"website-page-assignment"},
        );
      assignmentCounts.set(
        heading,
        (assignmentCounts.get(heading)??0)+1,
      );
    }
  }
  for(const heading of sectionByHeading.keys()){
    const count=assignmentCounts.get(heading)??0;
    if(count!==1)
      throw new ArtifactPipelineError(
        "PLAN_CONTENT",
        `Website section '${heading}' must be assigned exactly once; found ${count} assignments.`,
        {ruleOrPart:"website-page-assignment"},
      );
  }

  const collectedImages=await collectImages(
    config,
    {...plan,sections:contentSections},
    prompt,
    progress,
  );
  const images=collectedImages.images;
  emitBuildProgress(progress,{progress:95,stage:"render",message:`Rendering ${pages.length} website pages · ${images.size} photographs ready`,completed:images.size,total:collectedImages.metrics.requested,found:images.size});
  const placedImageQueries=new Set<string>();

  const assetByQuery=new Map<string,string>();
  const uniqueImageAssets=new Map<string,RealImage>();
  for(const [query,image] of images){
    const digest=createHash("sha256")
      .update(image.bytes)
      .digest("hex")
      .slice(0,20);
    const assetPath=`assets/images/${digest}.${image.extension === "png" ? "png" : "jpg"}`;
    assetByQuery.set(query,assetPath);
    if(!uniqueImageAssets.has(assetPath))
      uniqueImageAssets.set(assetPath,image);
  }

  const css=`:root{--ink:#17202a;--gold:#c99a2e;--paper:#f7f3ea;--navy:#17324d;--blue:#2f739c;--white:#fff;--muted:#5a6772}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font-family:Inter,Aptos,system-ui,sans-serif;color:var(--ink);background:var(--paper);line-height:1.65}nav{position:sticky;top:0;z-index:5;display:flex;gap:1.35rem;align-items:center;padding:1rem 6vw;background:#101d29f7;color:white;box-shadow:0 3px 18px #0003;backdrop-filter:blur(12px)}nav strong{margin-right:auto;letter-spacing:.04em}nav a{color:white;text-decoration:none;font-weight:650}nav a[aria-current=page]{color:#f1c65b;border-bottom:2px solid}.hero{isolation:isolate;position:relative;overflow:hidden;background:var(--navy);color:white;padding:clamp(5rem,10vw,8rem) 6vw;border-top:8px solid var(--gold)}.hero-photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-2}.hero:before{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(90deg,#10283df2 0%,#10283dc9 52%,#10283d52 100%)}.hero .eyebrow{text-transform:uppercase;letter-spacing:.18em;color:#f1c65b;font-size:.78rem;font-weight:800}.hero h1{font-size:clamp(2.8rem,6vw,5.7rem);letter-spacing:-.04em;line-height:.96;margin:.55rem 0 1rem;max-width:15ch}.hero p{font-size:clamp(1.05rem,2vw,1.3rem);max-width:56ch;color:#e0e9f0}main{max-width:1180px;margin:auto;padding:2rem 6vw 4rem}section{padding:clamp(3rem,6vw,5.5rem) 0;border-bottom:1px solid #d9d2c2}section.with-photo{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,.92fr);gap:clamp(2rem,5vw,5rem);align-items:center}.with-photo.flip .copy{order:2}.with-photo.flip .photo{order:1}.copy{min-width:0}h2{color:var(--navy);font-size:clamp(2rem,4vw,3.25rem);letter-spacing:-.035em;line-height:1.05;margin:.2rem 0 1.3rem}h3{color:var(--navy);margin:1.3rem 0 .65rem}p{font-size:1.08rem}li{margin:.55rem 0}a{color:#815e09}.photo{margin:0;background:white;padding:.65rem;border-radius:20px;box-shadow:0 18px 55px #12202b22;transform:rotate(.35deg)}.flip .photo{transform:rotate(-.35deg)}.photo img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;border-radius:14px}.photo figcaption{font-size:.75rem;line-height:1.35;color:var(--muted);padding:.65rem .3rem .15rem}.viz,.table-wrap,.activity{grid-column:1/-1;margin:2rem 0 0}.viz svg{width:100%;height:auto;display:block;box-shadow:0 15px 45px #12202b1b;border-radius:18px}.table{overflow:auto;background:white;border-radius:14px;box-shadow:0 12px 35px #12202b14}table{border-collapse:collapse;width:100%;min-width:560px}th,td{padding:.9rem 1rem;border-bottom:1px solid #dbe2e6;text-align:left}th{background:var(--navy);color:white}.activity{background:white;border-left:6px solid var(--gold);padding:1.25rem 1.5rem;border-radius:12px;box-shadow:0 10px 32px #12202b12}.corner-grid{display:grid;grid-template-columns:1fr 1fr;gap:.7rem;margin:1rem 0}.corner-grid div{padding:1rem;background:#eef3f5;border-radius:10px;font-weight:750;color:var(--navy);text-align:center}footer{padding:2.4rem 6vw;background:#101d29;color:#ccd6df}footer a{color:#f1c65b}@media(max-width:760px){nav{align-items:flex-start;flex-wrap:wrap}.hero{padding-top:4rem}nav strong{width:100%}section.with-photo{display:block}.with-photo.flip .copy,.with-photo.flip .photo{order:initial}.photo{margin-top:2rem;transform:none!important}.corner-grid{grid-template-columns:1fr}table{min-width:480px}}`;

  const HOME_FILE="MAIN_HOMEPAGE.html";
  const fileName=(page:(typeof pages)[number])=>
    page.slug==="index"?HOME_FILE:`${page.slug}.html`;
  const nav=(active:string)=>`<nav aria-label="Primary"><strong>${escapeHtml(plan.title)}</strong>${pages.map(page=>`<a href="${fileName(page)}"${page.slug===active?' aria-current="page"':""}>${escapeHtml(page.title)}</a>`).join("")}<a href="attributions.html"${active==="attributions"?' aria-current="page"':""}>Credits</a></nav>`;

  const renderActivity=(section:ArtifactPlan["sections"][number])=>{
    const activity=section.activity;
    if(!activity)return "";
    const corners=activity.type==="four_corners"&&activity.cornerLabels.length
      ?`<div class="corner-grid">${activity.cornerLabels.map(label=>`<div>${escapeHtml(label)}</div>`).join("")}</div>`
      :"";
    return `<aside class="activity"><h3>${escapeHtml(activity.type.replace(/_/g," "))} · ${activity.durationMinutes} min</h3><h3>Directions</h3><ol>${activity.directions.map(value=>`<li>${escapeHtml(value)}</li>`).join("")}</ol>${corners}<h3>Prompts</h3><ul>${activity.prompts.map(value=>`<li>${escapeHtml(value)}</li>`).join("")}</ul>${activity.sentenceFrames.length?`<h3>Sentence frames</h3><ul>${activity.sentenceFrames.map(value=>`<li>${escapeHtml(value)}</li>`).join("")}</ul>`:""}</aside>`;
  };

  const renderSection=(
    section:ArtifactPlan["sections"][number],
    index:number,
  )=>{
    const image=section.imageQuery
      ?images.get(section.imageQuery)
      :undefined;
    const imagePath=section.imageQuery
      ?assetByQuery.get(section.imageQuery)
      :undefined;
    if(image&&imagePath&&section.imageQuery)
      placedImageQueries.add(section.imageQuery);
    return `<section class="${image&&imagePath?`with-photo${index%2?" flip":""}`:""}"><div class="copy"><h2>${escapeHtml(section.heading)}</h2><p>${escapeHtml(section.body)}</p>${section.bullets.length?`<ul>${section.bullets.map(bullet=>`<li>${escapeHtml(bullet)}</li>`).join("")}</ul>`:""}</div>${image&&imagePath?`<figure class="photo"><img src="${imagePath}" alt="${escapeHtml(image.title)}" loading="lazy"><figcaption>${escapeHtml(image.title)} — ${escapeHtml(image.creator)} · ${escapeHtml(image.license)} · <a href="${escapeHtml(image.sourceUrl)}" rel="noopener noreferrer">source</a></figcaption></figure>`:""}${section.table?`<figure class="table-wrap"><figcaption>${escapeHtml(section.table.title)}</figcaption><div class="table"><table><thead><tr>${section.table.headers.map(header=>`<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${section.table.rows.map(row=>`<tr>${row.map(value=>`<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></figure>`:""}${section.chart?`<figure class="viz">${chartSvg(section.chart)}</figure>`:""}${section.diagram?`<figure class="viz">${diagramSvg(section.diagram)}</figure>`:""}${renderActivity(section)}</section>`;
  };

  const fallbackHeroPath=[...assetByQuery.values()][0];
  const shell=(
    title:string,
    description:string,
    active:string,
    body:string,
    heroPath?:string,
  )=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${escapeHtml(description)}"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)} · ${escapeHtml(plan.title)}</title><link rel="stylesheet" href="assets/styles.css"></head><body>${nav(active)}<header class="hero">${heroPath?`<img class="hero-photo" src="${heroPath}" alt="">`:""}<div class="eyebrow">Agent Díaz field guide</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></header><main>${body}</main><footer>Created with Agent Díaz · <a href="attributions.html">Sources and image credits</a></footer></body></html>`;

  const htmlPages=pages.map(page=>{
    const sections=page.sectionHeadings.map(
      heading=>sectionByHeading.get(heading)!,
    );
    const pageHeroPath=sections
      .map(section=>section.imageQuery
        ?assetByQuery.get(section.imageQuery)
        :undefined)
      .find((value):value is string=>Boolean(value));
    return {
      name:fileName(page),
      html:shell(
        page.title,
        page.description,
        page.slug,
        sections.map(renderSection).join(""),
        pageHeroPath,
      ),
    };
  });

  const uniqueCredits=[...uniqueImageAssets.entries()];
  const refs=`<section><h2>Research sources</h2>${plan.sources.length?`<ol>${plan.sources.map(source=>`<li><a href="${escapeHtml(source.url)}" rel="noopener noreferrer">${escapeHtml(source.title)}</a></li>`).join("")}</ol>`:"<p>No external research sources were used.</p>"}</section><section><h2>Image credits</h2>${uniqueCredits.length?`<ol>${uniqueCredits.map(([assetPath,image])=>`<li><a href="${assetPath}">${escapeHtml(image.title)}</a> — ${escapeHtml(image.creator)}, ${escapeHtml(image.license)}. <a href="${escapeHtml(image.sourceUrl)}" rel="noopener noreferrer">Wikimedia Commons source</a></li>`).join("")}</ol>`:"<p>No photographs were delivered for this build.</p>"}</section>`;
  htmlPages.push({
    name:"attributions.html",
    html:shell(
      "Sources & credits",
      "Research references and licenses for every bundled photograph.",
      "attributions",
      refs,
      fallbackHeroPath,
    ),
  });
  const home=htmlPages.find(page=>page.name===HOME_FILE);
  if(!home)
    throw new ArtifactPipelineError(
      "BUILD",
      "Website build did not produce the canonical main homepage.",
      {ruleOrPart:"website-index"},
    );
  // MAIN_HOMEPAGE.html is the clearly labelled local entry point and every
  // generated navigation bar links back to it. index.html remains the standard
  // hosting alias, while the OPEN_ME files preserve existing user workflows.
  htmlPages.push(
    {name:"index.html",html:home.html},
    {name:"OPEN_ME_FIRST_HOME_PAGE.html",html:home.html},
    {name:"OPEN_ME_FIRST.html",html:home.html},
  );

  const unplacedFetched=[...images.keys()].filter(
    query=>!placedImageQueries.has(query),
  );
  if(unplacedFetched.length)
    throw new ArtifactPipelineError(
      "BUILD",
      `Website layout discarded fetched images: ${unplacedFetched.join(", ")}`,
      {ruleOrPart:"website-image-placement"},
    );

  const stream=new PassThrough(),chunks:Buffer[]=[];
  stream.on("data",chunk=>chunks.push(Buffer.from(chunk)));
  const done=new Promise<Buffer>((resolve,reject)=>{
    stream.on("end",()=>resolve(Buffer.concat(chunks)));
    stream.on("error",reject);
  });
  const zip=archiver("zip",{zlib:{level:9}});
  zip.on("error",error=>stream.destroy(error));
  zip.pipe(stream);
  zip.append(css,{name:"assets/styles.css"});
  for(const [assetPath,image] of uniqueImageAssets)
    zip.append(image.bytes,{name:assetPath});
  for(const page of htmlPages)
    zip.append(page.html,{name:page.name});
  await zip.finalize();
  const buf=await done;
  if(buf.length<1500)
    throw new Error("Website ZIP validation failed");

  const name=`${slug(plan.title)}_website.zip`;
  const target=safeJoin(config.artifactDir,name);
  atomicWrite(target,buf);
  collectedImages.metrics.placed=placedImageQueries.size;
  log("info", "artifact.image_summary", {
    kind:"website",
    requested:collectedImages.metrics.requested,
    judged:collectedImages.metrics.judged,
    fetched:collectedImages.metrics.fetched,
    placed:collectedImages.metrics.placed,
    unresolved:Math.max(0,collectedImages.metrics.requested-collectedImages.metrics.placed),
    uniqueFiles:uniqueImageAssets.size,
  });
  emitBuildProgress(progress,{progress:98,stage:"validate",message:`Checking website package, links, and ${uniqueImageAssets.size} image assets`});
  const validationReceipt=await validateBuiltArtifact(
    "website",
    prompt,
    plan,
    target,
    jobId
      ?{root:path.join(config.storageRoot,"diagnostics"),jobId}
      :undefined,
  );
  collectedImages.metrics.placed=placedImageQueries.size;
  const enrichedReceipt=validationReceipt as ArtifactValidationReceipt & {
    images:ImageResolutionReceipt;
    website:WebsiteBuildReceipt;
  };
  enrichedReceipt.images=collectedImages.metrics;
  enrichedReceipt.website={
    plannedPages:pages.map(page=>page.slug),
    renderedPages:pages.length,
    sectionAssignments:[...assignmentCounts.values()].reduce(
      (sum,count)=>sum+count,
      0,
    ),
    uniqueImageFiles:uniqueImageAssets.size,
    sharedStylesheet:"assets/styles.css",
    brokenInternalResources:0,
  };
  emitBuildProgress(progress,{progress:99,stage:"package",message:`Website packaged · ${pages.length} pages · ${uniqueImageAssets.size} image files`});
  return{
    name,
    mime:"application/zip",
    path:target,
    size:buf.length,
    validationReceipt,
  };
}

export async function buildArtifact(
  config: Config,
  kind: JobKind,
  plan: ArtifactPlan,
  prompt = "",
  jobId = "",
  progress?: ArtifactBuildProgressHandler,
): Promise<BuiltFile> {
  // Builder boundary is independently safe: callers cannot bypass deterministic
  // pagination/reflow by invoking buildArtifact directly. The compiler is
  // intentionally idempotent, so AgentRunner may also compile before this point.
  const visualized = planArtifactVisuals(kind, plan, prompt);
  log("info", "artifact.visual_plan", { kind, ...visualized.receipt });
  emitBuildProgress(progress,{progress:83,stage:"visual-plan",message:`Planning visuals: ${visualized.receipt.plannedSlots} image slots${visualized.receipt.suppressedExplicitQueries ? ` · ${visualized.receipt.suppressedExplicitQueries} excess model slots suppressed` : ""}`,total:visualized.receipt.plannedSlots,completed:0,found:0});
  const compiledPlan = compileArtifactPlan(kind, visualized.plan).plan;
  if (kind === "presentation") return pptx(config, compiledPlan, prompt, jobId, progress);
  if (kind === "document" || kind === "analysis" || kind === "research")
    return docx(config, compiledPlan, prompt, kind, jobId, progress);
  if (kind === "website") return website(config, compiledPlan, prompt, jobId, progress);
  throw new ArtifactPipelineError(
    "BUILD",
    `No deterministic builder for ${kind}`,
    { ruleOrPart: "builder-dispatch" },
  );
}

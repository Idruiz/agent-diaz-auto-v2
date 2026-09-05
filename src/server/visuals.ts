import sharp from "sharp";

export interface ChartSpec {
  title: string;
  type: "bar" | "line" | "pie" | "donut";
  labels: string[];
  series: Array<{ name: string; values: number[] }>;
  unit?: string;
  sourceNote?: string;
}

export type ChartRenderMode = "standard" | "horizontal" | "outlier-split";
export type DiagramRenderMode = "row" | "grid" | "stack";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const palette = ["#c99a2e", "#2f739c", "#70a37f", "#c8664f", "#8067a8"];

function wrapWords(value: string, maxChars: number, maxLines = 4): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length >= maxLines - 1) break;
  }
  const consumedWords = lines.join(" ").split(/\s+/).filter(Boolean).length;
  const remaining = words.slice(consumedWords);
  if (current && lines.length < maxLines) {
    const final = remaining.join(" ") || current;
    lines.push(final.length > maxChars * 1.25 ? `${final.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…` : final);
  }
  return lines.slice(0, maxLines);
}

function textBlock(
  lines: string[],
  x: number,
  y: number,
  className: string,
  anchor: "start" | "middle" | "end" = "middle",
  lineHeight = 18,
): string {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${className}">${lines
    .map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${esc(line)}</tspan>`)
    .join("")}</text>`;
}

function finiteValues(spec: ChartSpec): number[] {
  return spec.series.flatMap((series) => series.values).filter(Number.isFinite);
}

export function chartRenderMode(spec: ChartSpec): ChartRenderMode {
  if (spec.type !== "bar") return "standard";
  const values = finiteValues(spec).map((value) => Math.abs(value)).filter((value) => value > 0);
  if (spec.series.length === 1 && values.length >= 4) {
    const sorted = [...values].sort((a, b) => b - a);
    if (sorted[1] && sorted[0]! / sorted[1] >= 8) return "outlier-split";
  }
  if (spec.labels.some((label) => label.length > 16) || spec.labels.length > 7) return "horizontal";
  return "standard";
}

function verticalBarChart(spec: ChartSpec, width: number, height: number): string {
  const pad = { l: 78, r: 28, t: 82, b: 116 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const all = finiteValues(spec);
  const max = Math.max(1, ...all.map(Math.abs)) * 1.12;
  const group = w / Math.max(1, spec.labels.length);
  const bw = Math.max(8, (group * 0.72) / Math.max(1, spec.series.length));
  let marks = "";
  spec.labels.forEach((label, i) => {
    spec.series.forEach((series, j) => {
      const value = series.values[i] ?? 0;
      const barHeight = (h * Math.abs(value)) / max;
      const x = pad.l + i * group + group * 0.14 + j * bw;
      const y = pad.t + h - barHeight;
      marks += `<rect x="${x}" y="${y}" width="${Math.max(4, bw - 3)}" height="${barHeight}" rx="3" fill="${palette[j % palette.length]}"/>`;
      marks += `<text x="${x + bw / 2}" y="${Math.max(pad.t + 13, y - 7)}" text-anchor="middle" class="val">${esc(String(value))}</text>`;
    });
    marks += textBlock(wrapWords(label, 13, 2), pad.l + i * group + group / 2, pad.t + h + 26, "lab", "middle", 17);
  });
  return `<line x1="${pad.l}" y1="${pad.t + h}" x2="${pad.l + w}" y2="${pad.t + h}" stroke="#cad3d9"/>${marks}`;
}

function horizontalBarChart(spec: ChartSpec, width: number, height: number): string {
  const pad = { l: 230, r: 52, t: 86, b: 86 };
  const w = width - pad.l - pad.r;
  const rows = Math.max(1, spec.labels.length);
  const h = height - pad.t - pad.b;
  const rowH = h / rows;
  const all = finiteValues(spec);
  const max = Math.max(1, ...all.map(Math.abs)) * 1.08;
  let marks = "";
  spec.labels.forEach((label, i) => {
    const centerY = pad.t + i * rowH + rowH / 2;
    marks += textBlock(wrapWords(label, 24, 2), pad.l - 16, centerY - 5, "lab", "end", 15);
    spec.series.forEach((series, j) => {
      const value = series.values[i] ?? 0;
      const barH = Math.max(8, Math.min(22, (rowH * 0.68) / Math.max(1, spec.series.length)));
      const y = centerY - ((spec.series.length * barH) / 2) + j * barH;
      const barW = (w * Math.abs(value)) / max;
      marks += `<rect x="${pad.l}" y="${y}" width="${barW}" height="${Math.max(5, barH - 3)}" rx="3" fill="${palette[j % palette.length]}"/>`;
      marks += `<text x="${Math.min(width - pad.r + 4, pad.l + barW + 8)}" y="${y + Math.max(10, barH - 7)}" class="val">${esc(String(value))}</text>`;
    });
  });
  return `<line x1="${pad.l}" y1="${pad.t - 6}" x2="${pad.l}" y2="${pad.t + h}" stroke="#cad3d9"/>${marks}`;
}

function outlierSplitBarChart(spec: ChartSpec, width: number, height: number): string {
  const series = spec.series[0]!;
  const indexed = series.values.map((value, index) => ({ value, index, abs: Math.abs(value) }));
  const outlier = [...indexed].sort((a, b) => b.abs - a.abs)[0]!;
  const normal = indexed.filter((item) => item.index !== outlier.index);
  const pad = { l: 78, r: 250, t: 86, b: 122 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const max = Math.max(1, ...normal.map((item) => item.abs)) * 1.15;
  const group = w / Math.max(1, normal.length);
  const bw = Math.max(20, group * 0.52);
  let marks = `<text x="${pad.l}" y="${pad.t - 20}" class="sub">Comparable values</text>`;
  normal.forEach((item, position) => {
    const barHeight = (h * item.abs) / max;
    const x = pad.l + position * group + (group - bw) / 2;
    const y = pad.t + h - barHeight;
    marks += `<rect x="${x}" y="${y}" width="${bw}" height="${barHeight}" rx="4" fill="${palette[0]}"/>`;
    marks += `<text x="${x + bw / 2}" y="${Math.max(pad.t + 14, y - 8)}" text-anchor="middle" class="val">${esc(String(item.value))}</text>`;
    marks += textBlock(wrapWords(spec.labels[item.index] ?? "", 13, 2), x + bw / 2, pad.t + h + 26, "lab", "middle", 17);
  });
  const calloutX = width - 214;
  const calloutY = pad.t + 38;
  marks += `<rect x="${calloutX}" y="${calloutY}" width="176" height="${Math.min(230, h - 12)}" rx="18" fill="#f1e5c5" stroke="#c99a2e" stroke-width="2"/>`;
  marks += `<text x="${calloutX + 88}" y="${calloutY + 62}" text-anchor="middle" class="big">${esc(String(outlier.value))}</text>`;
  marks += textBlock(wrapWords(spec.labels[outlier.index] ?? "Outlier", 19, 4), calloutX + 88, calloutY + 98, "callout", "middle", 19);
  marks += `<text x="${calloutX + 88}" y="${calloutY + 188}" text-anchor="middle" class="note">shown separately because its scale</text><text x="${calloutX + 88}" y="${calloutY + 205}" text-anchor="middle" class="note">would flatten the other values</text>`;
  return `<line x1="${pad.l}" y1="${pad.t + h}" x2="${pad.l + w}" y2="${pad.t + h}" stroke="#cad3d9"/>${marks}`;
}

export function chartSvg(spec: ChartSpec, width = 1000, height = 560): string {
  const mode = chartRenderMode(spec);
  let marks = "";
  let legend = "";
  if (spec.type === "bar") {
    marks = mode === "outlier-split"
      ? outlierSplitBarChart(spec, width, height)
      : mode === "horizontal"
        ? horizontalBarChart(spec, width, height)
        : verticalBarChart(spec, width, height);
  } else if (spec.type === "line") {
    const pad = { l: 86, r: 28, t: 78, b: 102 };
    const w = width - pad.l - pad.r;
    const h = height - pad.t - pad.b;
    const all = finiteValues(spec);
    const max = Math.max(1, ...all.map(Math.abs)) * 1.12;
    const dx = w / Math.max(1, spec.labels.length - 1);
    spec.series.forEach((series, j) => {
      const points = series.values.map((value, i) => `${pad.l + i * dx},${pad.t + h - (h * value) / max}`).join(" ");
      marks += `<polyline points="${points}" fill="none" stroke="${palette[j % palette.length]}" stroke-width="5"/>`;
      series.values.forEach((value, i) => {
        const cy = pad.t + h - (h * value) / max;
        marks += `<circle cx="${pad.l + i * dx}" cy="${cy}" r="6" fill="${palette[j % palette.length]}"/><text x="${pad.l + i * dx}" y="${cy - 11}" text-anchor="middle" class="val">${esc(String(value))}</text>`;
      });
    });
    spec.labels.forEach((label, i) => {
      marks += textBlock(wrapWords(label, 12, 2), pad.l + i * dx, pad.t + h + 28, "lab", "middle", 16);
    });
    marks = `<line x1="${pad.l}" y1="${pad.t + h}" x2="${pad.l + w}" y2="${pad.t + h}" stroke="#cad3d9"/>${marks}`;
  } else {
    const values = spec.series[0]!.values;
    const total = values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    const cx = width / 2 - 80;
    const cy = height / 2 + 16;
    const r = 145;
    const inner = spec.type === "donut" ? 78 : 0;
    let angle = -Math.PI / 2;
    values.forEach((value, i) => {
      const n = Math.max(0, value);
      const end = angle + (n / total) * Math.PI * 2;
      const large = end - angle > Math.PI ? 1 : 0;
      const p1 = [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
      const p2 = [cx + r * Math.cos(end), cy + r * Math.sin(end)];
      const q1 = [cx + inner * Math.cos(end), cy + inner * Math.sin(end)];
      const q2 = [cx + inner * Math.cos(angle), cy + inner * Math.sin(angle)];
      marks += inner
        ? `<path d="M${p1} A${r},${r} 0 ${large},1 ${p2} L${q1} A${inner},${inner} 0 ${large},0 ${q2} Z" fill="${palette[i % palette.length]}"/>`
        : `<path d="M${cx},${cy} L${p1} A${r},${r} 0 ${large},1 ${p2} Z" fill="${palette[i % palette.length]}"/>`;
      angle = end;
      legend += `<rect x="${width - 280}" y="${110 + i * 34}" width="15" height="15" fill="${palette[i % palette.length]}"/>${textBlock(wrapWords(`${spec.labels[i] ?? ""} (${value})`, 26, 2), width - 255, 123 + i * 34, "lab", "start", 15)}`;
    });
  }

  if (spec.series.length > 1) {
    spec.series.forEach((series, i) => {
      legend += `<circle cx="${100 + i * 180}" cy="${height - 34}" r="7" fill="${palette[i % palette.length]}"/><text x="${114 + i * 180}" y="${height - 29}" class="lab">${esc(series.name)}</text>`;
    });
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>text{font-family:'DejaVu Sans','Liberation Sans',sans-serif;fill:#17324d}.title{font-size:27px;font-weight:700}.sub{font-size:16px;font-weight:700}.lab{font-size:14px}.val{font-size:13px;font-weight:700}.big{font-size:34px;font-weight:800}.callout{font-size:15px;font-weight:700}.note{font-size:12px;fill:#667784}</style><rect width="100%" height="100%" rx="18" fill="#fff"/><text x="60" y="44" class="title">${esc(spec.title)}</text>${marks}${legend}<text x="60" y="${height - 10}" class="note">${esc(spec.sourceNote || "")}</text></svg>`;
}

export async function chartPng(spec: ChartSpec): Promise<Buffer> {
  return sharp(Buffer.from(chartSvg(spec))).png().toBuffer();
}

export function diagramRenderMode(nodes: string[]): DiagramRenderMode {
  const longest = Math.max(0, ...nodes.map((node) => node.length));
  if (nodes.length <= 4 && longest <= 28) return "row";
  if (nodes.length <= 8 && longest <= 58) return "grid";
  return "stack";
}

type DiagramBox = { x: number; y: number; w: number; h: number; lines: string[]; index: number };

function diagramBoxes(nodes: string[], width: number, mode: DiagramRenderMode): { boxes: DiagramBox[]; height: number } {
  const side = 54;
  const top = 112;
  const gapX = 28;
  const gapY = 28;
  const usable = width - side * 2;
  let columns = nodes.length;
  if (mode === "grid") columns = nodes.length <= 5 ? 2 : 3;
  if (mode === "stack") columns = 1;
  columns = Math.max(1, Math.min(columns, nodes.length));
  const boxW = (usable - gapX * (columns - 1)) / columns;
  const maxChars = Math.max(10, Math.floor(boxW / 9.2));
  const rows = Math.ceil(nodes.length / columns);
  const rowHeights = Array.from({ length: rows }, () => 0);
  const wrapped = nodes.map((node, index) => {
    const lines = wrapWords(node, maxChars, mode === "stack" ? 3 : 4);
    const required = Math.max(68, 34 + lines.length * 18);
    rowHeights[Math.floor(index / columns)] = Math.max(rowHeights[Math.floor(index / columns)]!, required);
    return lines;
  });
  const rowY: number[] = [];
  let y = top;
  for (const rowHeight of rowHeights) {
    rowY.push(y);
    y += rowHeight + gapY;
  }
  const boxes = nodes.map((_, index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    return {
      x: side + col * (boxW + gapX),
      y: rowY[row]!,
      w: boxW,
      h: rowHeights[row]!,
      lines: wrapped[index]!,
      index,
    };
  });
  return { boxes, height: Math.max(420, y + 62) };
}

function connector(from: DiagramBox, to: DiagramBox): string {
  const sameRow = Math.abs(from.y - to.y) < 1;
  if (sameRow) {
    const y = from.y + from.h / 2;
    return `<path d="M${from.x + from.w},${y} L${to.x - 8},${y}" stroke="#2f739c" stroke-width="3" fill="none" marker-end="url(#a)"/>`;
  }
  const fromX = from.x + from.w / 2;
  const fromY = from.y + from.h;
  const toX = to.x + to.w / 2;
  const toY = to.y - 8;
  const midY = fromY + Math.max(12, (toY - fromY) / 2);
  return `<path d="M${fromX},${fromY} L${fromX},${midY} L${toX},${midY} L${toX},${toY}" stroke="#2f739c" stroke-width="3" fill="none" marker-end="url(#a)"/>`;
}

export function diagramSvg(
  diagram: { title: string; nodes: string[]; caption?: string },
  width = 1000,
  height = 420,
): string {
  const nodes = diagram.nodes.slice(0, 12);
  const mode = diagramRenderMode(nodes);
  const layout = diagramBoxes(nodes, width, mode);
  const finalHeight = Math.max(height, layout.height + (diagram.caption ? 34 : 0));
  let body = "";
  for (let index = 0; index < layout.boxes.length - 1; index++) {
    body += connector(layout.boxes[index]!, layout.boxes[index + 1]!);
  }
  for (const box of layout.boxes) {
    body += `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="14" fill="${box.index % 2 ? "#e7eef2" : "#f1e5c5"}" stroke="#c99a2e"/>`;
    const blockHeight = (box.lines.length - 1) * 18;
    body += textBlock(box.lines, box.x + box.w / 2, box.y + box.h / 2 - blockHeight / 2 + 5, "node", "middle", 18);
  }
  const captionY = finalHeight - 28;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${finalHeight}" viewBox="0 0 ${width} ${finalHeight}"><defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#2f739c"/></marker></defs><style>text{font-family:'DejaVu Sans','Liberation Sans',sans-serif;fill:#17324d}.title{font-size:28px;font-weight:bold}.node{font-size:14px;font-weight:700}.cap{font-size:13px;fill:#667784}</style><rect width="100%" height="100%" fill="#fff"/><text x="54" y="54" class="title">${esc(diagram.title)}</text>${body}${diagram.caption ? `<text x="54" y="${captionY}" class="cap">${esc(diagram.caption)}</text>` : ""}</svg>`;
}

export async function diagramPng(diagram: { title: string; nodes: string[]; caption?: string }): Promise<Buffer> {
  return sharp(Buffer.from(diagramSvg(diagram))).png().toBuffer();
}

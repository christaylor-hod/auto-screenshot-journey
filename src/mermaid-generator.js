import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

/**
 * Generate diagram outputs from crawl data:
 *   - .mmd file (Mermaid source, LR orientation)
 *   - .html file (interactive diagram with screenshots, zoom/pan, editable text, exports)
 *   - .pdf file (rendered from HTML)
 */
export async function generateMermaid(crawlData, outputDir) {
  const { pages, edges } = crawlData;
  const outputPath = path.join(outputDir, 'journey-map.mmd');
  const htmlOutputPath = path.join(outputDir, 'journey-map.html');
  const pdfOutputPath = path.join(outputDir, 'journey-map.pdf');

  const mermaidContent = generateMermaidSource(crawlData);
  fs.writeFileSync(outputPath, mermaidContent);
  console.log(`📊 Mermaid diagram saved: ${outputPath}`);

  const htmlContent = generateHtml(crawlData, outputDir);
  fs.writeFileSync(htmlOutputPath, htmlContent);
  console.log(`🌐 Interactive HTML map saved: ${htmlOutputPath}`);

  console.log(`📄 Rendering PDF...`);
  try {
    const browser = await chromium.launch({
      headless: true, channel: 'chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`file://${path.resolve(htmlOutputPath)}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForSelector('.node-card', { timeout: 20000 }).catch(() => {
      console.warn('  ⚠ Diagram nodes not detected, PDF may be incomplete');
    });
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const c = document.getElementById('canvas');
      const v = document.getElementById('viewport');
      if (c) c.style.transform = 'none';
      if (v) { v.style.height = 'auto'; v.style.overflow = 'visible'; v.style.cursor = 'default'; }
      document.querySelectorAll('.toolbar, .tabs').forEach(el => el.style.display = 'none');
      const sp = document.getElementById('screenshots');
      if (sp) sp.style.display = 'none';
    });
    const ds = await page.evaluate(() => {
      const c = document.getElementById('diagram-container');
      return c ? { width: c.scrollWidth, height: c.scrollHeight } : null;
    });
    let pw = '594mm', ph = '420mm';
    if (ds) {
      pw = `${Math.max(Math.ceil((ds.width / 96) * 25.4) + 60, 420)}mm`;
      ph = `${Math.max(Math.ceil((ds.height / 96) * 25.4) + 60, 297)}mm`;
    }
    await page.pdf({ path: pdfOutputPath, width: pw, height: ph, printBackground: true,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' } });
    await browser.close();
    console.log(`📄 PDF saved: ${pdfOutputPath}`);
  } catch (err) {
    console.warn(`  ⚠ PDF generation failed: ${err.message}`);
    console.warn(`    The HTML file is still available at: ${htmlOutputPath}`);
  }
  return { mermaidPath: outputPath, htmlPath: htmlOutputPath, pdfPath: pdfOutputPath };
}

// ── Mermaid .mmd source ──
function generateMermaidSource(crawlData) {
  const { pages, edges } = crawlData;
  const lines = ['flowchart LR']; lines.push('');
  const nodeIds = new Map(); let counter = 0;
  function nid(url) { if (!nodeIds.has(url)) nodeIds.set(url, `p${counter++}`); return nodeIds.get(url); }
  function sanitize(t) { return (t||'Unknown').replace(/"/g,"'").replace(/[<>]/g,'').replace(/\n/g,' ').substring(0,60); }
  const defined = new Set();
  for (const [url, pd] of pages) {
    const id = nid(url), label = sanitize(pd.pageName||pd.h1||url), fc = pd.fields.length;
    if (pd.isEndPage) lines.push(`  ${id}(["${label} | ${fc} fields"])`);
    else if (pd.choicePoints.length>0) lines.push(`  ${id}{{"${label} | ${fc} fields | ${pd.choicePoints.length} choices"}}`);
    else lines.push(`  ${id}["${label}${fc>0?' | '+fc+' fields':''}"]`);
    defined.add(id);
  }
  lines.push('');
  const es = new Set();
  for (const e of edges) {
    const f=nid(e.from),t=nid(e.to),k=`${f}-${t}-${e.label}`;
    if(es.has(k))continue; es.add(k);
    if(defined.has(f)&&defined.has(t)){const l=sanitize(e.label);if(l&&l!=='continue')lines.push(`  ${f} -->|"${l}"| ${t}`);else lines.push(`  ${f} --> ${t}`);}
  }
  lines.push('');
  lines.push('  classDef endPage fill:#00703C,stroke:#00703C,color:#fff');
  lines.push('  classDef choicePage fill:#1D70B8,stroke:#1D70B8,color:#fff');
  lines.push('  classDef normalPage fill:#f3f2f1,stroke:#505a5f,color:#0b0c0c');
  lines.push('');
  for (const [url, pd] of pages) {
    const id = nid(url);
    if (pd.isEndPage) lines.push(`  class ${id} endPage`);
    else if (pd.choicePoints.length>0) lines.push(`  class ${id} choicePage`);
    else lines.push(`  class ${id} normalPage`);
  }
  return lines.join('\n');
}

// ── Interactive HTML ──
function generateHtml(crawlData, outputDir) {
  const { pages, edges, screenshots } = crawlData;
  const formTitle = escapeHtml(crawlData.formTitle || 'Form Journey Map');

  const nodes = []; const graphEdges = []; const nodeIdMap = new Map(); let idx = 0;
  for (const [url, pd] of pages) {
    const nodeId = `n${idx++}`; nodeIdMap.set(url, nodeId);
    let screenshotB64 = '';
    const ssPath = screenshots.get(url);
    if (ssPath && fs.existsSync(ssPath)) { try { screenshotB64 = fs.readFileSync(ssPath).toString('base64'); } catch {} }
    nodes.push({ id: nodeId, label: (pd.pageName||pd.h1||url).substring(0,80), url: pd.url,
      fieldCount: pd.fields.length, choiceCount: pd.choicePoints.length, isEndPage: pd.isEndPage, screenshot: screenshotB64 });
  }
  const edgeSet = new Set();
  for (const edge of edges) {
    const fromId=nodeIdMap.get(edge.from), toId=nodeIdMap.get(edge.to);
    if(!fromId||!toId)continue;
    const label=(edge.label||'').substring(0,50), key=`${fromId}-${toId}-${label}`;
    if(edgeSet.has(key))continue; edgeSet.add(key);
    graphEdges.push({ from: fromId, to: toId, label: label==='continue'?'':label });
  }
  const pageIndex = [];
  for (const [url, pd] of pages) {
    const ssPath = screenshots.get(url);
    pageIndex.push({ name: pd.pageName||url, url: pd.url, fieldCount: pd.fields.length,
      isEndPage: pd.isEndPage, screenshot: ssPath ? path.basename(ssPath) : null });
  }

  const nodesJson = JSON.stringify(nodes);
  const edgesJson = JSON.stringify(graphEdges);
  const galleryHtml = pageIndex.map(p => {
    const img = p.screenshot ? `<img src="screenshots/${p.screenshot}" alt="${escapeHtml(p.name)}" onclick="openLightbox(this.src)">` : '';
    const badges = [p.fieldCount>0?`<span class="gb gf">${p.fieldCount} fields</span>`:'',p.isEndPage?'<span class="gb ge">End page</span>':''].filter(Boolean).join(' ');
    return `<div class="card">${img}<div class="card-body"><h3>${escapeHtml(p.name)}</h3><p>${escapeHtml(p.url)}</p><div style="margin-top:8px">${badges}</div></div></div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${formTitle} — Journey Map</title>
<script src="https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js"></` + `script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"GDS Transport",Arial,sans-serif;background:#f3f2f1;color:#0b0c0c}
.header{background:#0b0c0c;color:#fff;padding:16px 24px}
.header h1{font-size:24px;font-weight:700}
.header p{color:#b1b4b6;margin-top:4px;font-size:14px}
.tabs{display:flex;background:#fff;border-bottom:1px solid #b1b4b6;padding:0 24px}
.tab{padding:12px 20px;cursor:pointer;font-size:16px;border-bottom:4px solid transparent;color:#1d70b8;user-select:none}
.tab:hover{color:#003078}.tab.active{border-bottom-color:#1d70b8;color:#0b0c0c;font-weight:700}
.panel{display:none;padding:24px}.panel.active{display:block}

/* Toolbar */
.toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;align-items:center}
.tb-group{display:flex;gap:4px;align-items:center;padding:0 8px;border-right:1px solid #b1b4b6}
.tb-group:last-child{border-right:none}
.tb-label{font-size:12px;color:#505a5f;margin-right:4px;white-space:nowrap}
.tb-btn{
  background:#fff;border:1px solid #b1b4b6;border-radius:4px;
  padding:5px 12px;cursor:pointer;font-size:13px;color:#1d70b8;line-height:1.3;white-space:nowrap;
}
.tb-btn:hover{background:#f3f2f1;color:#003078}
.tb-btn.active{background:#1d70b8;color:#fff;border-color:#1d70b8}
.zoom-level{font-size:12px;color:#505a5f;min-width:40px;text-align:center}

/* Level nav */
.level-nav{display:flex;gap:4px;align-items:center}
.level-display{font-size:12px;color:#505a5f;min-width:80px;text-align:center}

/* Viewport */
.mermaid-viewport{background:#fff;border:1px solid #b1b4b6;border-radius:4px;overflow:hidden;position:relative;height:75vh;cursor:grab}
.mermaid-viewport:active{cursor:grabbing}
.mermaid-canvas{transform-origin:0 0;position:absolute;top:0;left:0}
#diagram-container{position:relative}

/* Node cards */
.node-card{
  position:absolute;background:#fff;border:2px solid #b1b4b6;border-radius:6px;
  overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);cursor:grab;transition:box-shadow .15s;
}
.node-card:hover{box-shadow:0 2px 12px rgba(0,0,0,0.15)}
.node-card.dragging{cursor:grabbing;box-shadow:0 4px 20px rgba(0,0,0,0.25);z-index:100;opacity:0.92}
.node-card.choice{border-color:#1D70B8;border-width:3px}
.node-card.end-page{border-color:#00703C;border-width:3px}
.node-thumb{width:220px;height:140px;object-fit:cover;object-position:top left;display:block;border-bottom:1px solid #e0e0e0;background:#f8f8f8}
.node-thumb-placeholder{width:220px;height:140px;display:flex;align-items:center;justify-content:center;background:#f3f2f1;color:#b1b4b6;font-size:12px;border-bottom:1px solid #e0e0e0}
.node-info{padding:8px 10px;max-width:220px}
.node-title{
  font-size:12px;font-weight:700;color:#0b0c0c;line-height:1.3;
  min-height:1.3em;max-width:200px;outline:none;cursor:text;
}
.node-title:focus{background:#fff9e6;border-radius:2px}
.node-title[contenteditable]:hover{background:#f8f8f8;border-radius:2px}
.node-meta{font-size:11px;color:#505a5f;margin-top:4px}
.nb{display:inline-block;padding:1px 6px;font-size:10px;border-radius:3px;font-weight:700;margin-right:4px}
.nb-c{background:#1D70B8;color:#fff}.nb-e{background:#00703C;color:#fff}
.nb-f{background:#f3f2f1;color:#505a5f;border:1px solid #b1b4b6}

/* Edge labels */
.edge-label{
  position:absolute;font-size:10px;color:#505a5f;
  background:rgba(255,255,255,0.92);padding:2px 6px;border-radius:3px;
  pointer-events:auto;max-width:120px;width:max-content;
  text-align:center;line-height:1.3;word-wrap:break-word;
  border:1px solid #e0e0e0;transform:translate(-50%,-50%);
  outline:none;cursor:text;
}
.edge-label:focus{background:#fff9e6;border-color:#1d70b8}
.edge-label:hover{background:#f8f8f8}
.edge-label.hidden{display:none}
.edge-line{fill:none;stroke:#505a5f;stroke-width:1.5}
.edge-arrow{fill:#505a5f}

/* Text size variants */
.text-s .node-title{font-size:10px}
.text-s .edge-label{font-size:8px}
.text-s .nb{font-size:8px}
.text-m .node-title{font-size:12px}
.text-m .edge-label{font-size:10px}
.text-m .nb{font-size:10px}
.text-l .node-title{font-size:15px}
.text-l .edge-label{font-size:13px}
.text-l .nb{font-size:12px}

/* Stats */
.stats{display:flex;gap:24px;margin-bottom:20px}
.stat{background:#fff;padding:16px 24px;border:1px solid #b1b4b6;border-radius:4px;border-left:4px solid #1d70b8}
.stat-value{font-size:28px;font-weight:700}.stat-label{font-size:14px;color:#505a5f}

/* Gallery */
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(350px,1fr));gap:20px}
.card{background:#fff;border:1px solid #b1b4b6;border-radius:4px;overflow:hidden}
.card img{width:100%;border-bottom:1px solid #b1b4b6;cursor:pointer}
.card-body{padding:12px 16px}.card-body h3{font-size:16px;margin-bottom:4px}
.card-body p{font-size:14px;color:#505a5f}
.gb{display:inline-block;padding:2px 8px;font-size:12px;border-radius:3px;font-weight:700}
.ge{background:#00703C;color:#fff}.gf{background:#1d70b8;color:#fff}

/* Lightbox */
.lightbox{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:1000;justify-content:center;align-items:center;cursor:pointer}
.lightbox.active{display:flex}
.lightbox img{max-width:90vw;max-height:90vh;border:2px solid #fff;border-radius:4px}

/* Print */
@media print{
  body{background:#fff}
  .toolbar,.lightbox,.tabs{display:none!important}
  .panel{display:block!important;padding:10px}
  #screenshots{display:none!important}
  .header{background:#0b0c0c;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .mermaid-viewport{border:none;overflow:visible;height:auto;cursor:default}
  .mermaid-canvas{transform:none!important;position:relative}
  .stat,.node-card,.nb,.nb-c,.nb-e,.nb-f,.gb,.ge,.gf{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
</style>
</head>
<body>
<div class="header">
  <h1>${formTitle}</h1>
  <p>Journey map generated ${new Date().toISOString().split('T')[0]} — ${pages.size} pages discovered</p>
</div>
<div class="tabs">
  <div class="tab active" onclick="showTab('flowchart')">Flowchart</div>
  <div class="tab" onclick="showTab('screenshots')">Screenshots</div>
</div>
<div id="flowchart" class="panel active">
  <div class="stats">
    <div class="stat"><div class="stat-value">${pages.size}</div><div class="stat-label">Pages</div></div>
    <div class="stat"><div class="stat-value">${edges.length}</div><div class="stat-label">Connections</div></div>
    <div class="stat"><div class="stat-value">${crawlData.paths.length}</div><div class="stat-label">Paths</div></div>
  </div>
  <div class="toolbar">
    <div class="tb-group">
      <span class="tb-label">Zoom</span>
      <button class="tb-btn" onclick="zoomIn()">+</button>
      <button class="tb-btn" onclick="zoomOut()">&minus;</button>
      <button class="tb-btn" onclick="zoomFit()">Fit</button>
      <button class="tb-btn" onclick="zoomReset()">1:1</button>
      <span class="zoom-level" id="zoom-level">100%</span>
    </div>
    <div class="tb-group">
      <span class="tb-label">Layout</span>
      <button class="tb-btn active" id="btn-lr" onclick="setDirection('LR')">Horizontal</button>
      <button class="tb-btn" id="btn-tb" onclick="setDirection('TB')">Vertical</button>
    </div>
    <div class="tb-group">
      <span class="tb-label">Labels</span>
      <button class="tb-btn active" id="btn-labels" onclick="toggleLabels()">On</button>
    </div>
    <div class="tb-group">
      <span class="tb-label">Text</span>
      <button class="tb-btn" onclick="setTextSize('s')">S</button>
      <button class="tb-btn active" id="btn-text-m" onclick="setTextSize('m')">M</button>
      <button class="tb-btn" onclick="setTextSize('l')">L</button>
    </div>
    <div class="tb-group level-nav">
      <span class="tb-label">Level</span>
      <button class="tb-btn" onclick="prevLevel()">&larr;</button>
      <span class="level-display" id="level-display">All</span>
      <button class="tb-btn" onclick="nextLevel()">&rarr;</button>
    </div>
    <div class="tb-group">
      <span class="tb-label">Export</span>
      <button class="tb-btn" onclick="exportSvg()">SVG</button>
      <button class="tb-btn" onclick="exportPng()">PNG</button>
      <button class="tb-btn" onclick="exportPdf()">PDF</button>
    </div>
  </div>
  <div class="mermaid-viewport" id="viewport">
    <div class="mermaid-canvas text-m" id="canvas">
      <svg id="edges-svg" style="position:absolute;top:0;left:0;pointer-events:none;overflow:visible;">
        <defs><marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0,10 3.5,0 7" class="edge-arrow"/></marker></defs>
      </svg>
      <div id="diagram-container"></div>
    </div>
  </div>
</div>
<div id="screenshots" class="panel">
  <div class="gallery">${galleryHtml}</div>
</div>
<div class="lightbox" id="lightbox" onclick="closeLightbox()">
  <img id="lightbox-img" src="" alt="Screenshot">
</div>

<` + `script>
var NODES = ${nodesJson};
var EDGES = ${edgesJson};
var NODE_WIDTH = 224, NODE_HEIGHT = 206;
var currentDirection = 'LR';
var labelsVisible = true;
var currentLevel = -1; // -1 = all
var levelRanks = [];   // [{rank, nodeIds}]
var nodeEdits = {};    // nodeId -> edited label
var edgeEdits = {};    // edgeKey -> edited label

// ── Layout ──
function layoutGraph(dir) {
  var g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: dir, nodesep: 50, ranksep: 140, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(function(){return{}});
  NODES.forEach(function(n){ g.setNode(n.id, {width:NODE_WIDTH,height:NODE_HEIGHT}); });
  EDGES.forEach(function(e){ g.setEdge(e.from,e.to,{label:e.label||''}); });
  dagre.layout(g);
  return g;
}

function renderDiagram() {
  livePositions = {};  // Reset drag positions on re-render
  var g = layoutGraph(currentDirection);
  var container = document.getElementById('diagram-container');
  var svg = document.getElementById('edges-svg');
  container.innerHTML = '';

  var graph = g.graph();
  var tw = graph.width + 80, th = graph.height + 80;
  container.style.width = tw + 'px'; container.style.height = th + 'px';
  svg.setAttribute('width',tw); svg.setAttribute('height',th);
  svg.style.width = tw+'px'; svg.style.height = th+'px';

  // Track ranks for level navigation
  var rankMap = {};
  var nodePositions = {};

  g.nodes().forEach(function(id){
    var layout = g.node(id);
    var node = NODES.find(function(n){return n.id===id});
    if(!node||!layout) return;

    var x = layout.x - NODE_WIDTH/2, y = layout.y - NODE_HEIGHT/2;
    nodePositions[id] = {x:x,y:y,w:NODE_WIDTH,h:NODE_HEIGHT,cx:layout.x,cy:layout.y};

    // Track rank
    var rank = currentDirection==='LR' ? Math.round(layout.x/10)*10 : Math.round(layout.y/10)*10;
    if(!rankMap[rank]) rankMap[rank] = [];
    rankMap[rank].push(id);

    var card = document.createElement('div');
    card.className = 'node-card' + (node.choiceCount>0?' choice':'') + (node.isEndPage?' end-page':'');
    card.style.left = x+'px'; card.style.top = y+'px'; card.style.width = NODE_WIDTH+'px';
    card.dataset.nodeId = node.id;

    if(node.screenshot){
      var img = document.createElement('img');
      img.className='node-thumb'; img.src='data:image/png;base64,'+node.screenshot; img.alt=node.label;
      card.appendChild(img);
    } else {
      var ph = document.createElement('div'); ph.className='node-thumb-placeholder'; ph.textContent='No screenshot';
      card.appendChild(ph);
    }

    var info = document.createElement('div'); info.className='node-info';
    var title = document.createElement('div'); title.className='node-title';
    title.contentEditable = 'true';
    title.textContent = nodeEdits[node.id] || node.label;
    title.addEventListener('blur', function(){ nodeEdits[node.id] = this.textContent.trim(); });
    title.addEventListener('keydown', function(e){ if(e.key==='Enter'){e.preventDefault();this.blur();} });
    info.appendChild(title);

    var meta = document.createElement('div'); meta.className='node-meta';
    if(node.choiceCount>0) meta.innerHTML+='<span class="nb nb-c">'+node.choiceCount+' choice'+(node.choiceCount>1?'s':'')+'</span>';
    if(node.isEndPage) meta.innerHTML+='<span class="nb nb-e">End</span>';
    if(node.fieldCount>0) meta.innerHTML+='<span class="nb nb-f">'+node.fieldCount+' field'+(node.fieldCount>1?'s':'')+'</span>';
    info.appendChild(meta);
    card.appendChild(info);
    container.appendChild(card);
  });

  // Build level ranks sorted
  var sortedRanks = Object.keys(rankMap).map(Number).sort(function(a,b){return a-b});
  levelRanks = sortedRanks.map(function(r,i){ return {rank:r, index:i, nodeIds:rankMap[r]}; });
  updateLevelDisplay();

  // Render edges
  var defs = svg.querySelector('defs');
  svg.innerHTML = ''; svg.appendChild(defs);

  g.edges().forEach(function(e){
    var edgeData = g.edge(e), from = nodePositions[e.v], to = nodePositions[e.w];
    if(!from||!to||!edgeData) return;
    var points = edgeData.points || [];
    var sx,sy,ex,ey;
    if(currentDirection==='LR'){
      sx=from.cx+from.w/2; sy=from.cy; ex=to.cx-to.w/2; ey=to.cy;
    } else {
      sx=from.cx; sy=from.cy+from.h/2; ex=to.cx; ey=to.cy-to.h/2;
    }

    var d;
    if(points.length>=2){
      d='M '+sx+' '+sy;
      for(var i=1;i<points.length-1;i++){
        var p=points[i];
        if(i===points.length-2){d+=' Q '+p.x+' '+p.y+' '+ex+' '+ey;}
        else{var nx=points[i+1];d+=' Q '+p.x+' '+p.y+' '+(p.x+nx.x)/2+' '+(p.y+nx.y)/2;}
      }
      if(points.length===2) d+=' L '+ex+' '+ey;
    } else { d='M '+sx+' '+sy+' L '+ex+' '+ey; }

    var pathEl=document.createElementNS('http://www.w3.org/2000/svg','path');
    pathEl.setAttribute('d',d); pathEl.setAttribute('class','edge-line');
    pathEl.setAttribute('marker-end','url(#arrowhead)');
    svg.appendChild(pathEl);

    var label = edgeData.label||'';
    if(label){
      var edgeKey = e.v+'-'+e.w;
      var midIdx=Math.floor(points.length/2);
      var midPt=points[midIdx]||{x:(sx+ex)/2,y:(sy+ey)/2};
      var lbl=document.createElement('div');
      lbl.className='edge-label'+(labelsVisible?'':' hidden');
      lbl.contentEditable='true';
      lbl.textContent=edgeEdits[edgeKey]||label;
      lbl.dataset.edgeKey=edgeKey;
      lbl.style.left=midPt.x+'px'; lbl.style.top=midPt.y+'px';
      lbl.addEventListener('blur',function(){ edgeEdits[this.dataset.edgeKey]=this.textContent.trim(); });
      lbl.addEventListener('keydown',function(e){ if(e.key==='Enter'){e.preventDefault();this.blur();} });
      container.appendChild(lbl);
    }
  });
}

// ── Direction toggle ──
function setDirection(dir){
  currentDirection = dir;
  document.getElementById('btn-lr').classList.toggle('active', dir==='LR');
  document.getElementById('btn-tb').classList.toggle('active', dir==='TB');
  currentLevel = -1;
  renderDiagram();
  setTimeout(zoomFit, 100);
}

// ── Label toggle ──
function toggleLabels(){
  labelsVisible = !labelsVisible;
  var btn = document.getElementById('btn-labels');
  btn.classList.toggle('active', labelsVisible);
  btn.textContent = labelsVisible ? 'On' : 'Off';
  document.querySelectorAll('.edge-label').forEach(function(el){
    el.classList.toggle('hidden', !labelsVisible);
  });
}

// ── Text size ──
var currentTextSize = 'm';
function setTextSize(size){
  currentTextSize = size;
  var c = document.getElementById('canvas');
  c.classList.remove('text-s','text-m','text-l');
  c.classList.add('text-'+size);
  document.querySelectorAll('.tb-group').forEach(function(g){
    var btns = g.querySelectorAll('.tb-btn');
    btns.forEach(function(b){
      if(b.textContent==='S'||b.textContent==='M'||b.textContent==='L'){
        b.classList.toggle('active', b.textContent.toLowerCase()===size);
      }
    });
  });
}

// ── Node dragging ──
var dragState = null;       // { card, startLeft, startTop, startMouseX, startMouseY }
var livePositions = {};     // nodeId -> {x, y} — updated live as nodes are dragged

function initDrag(){
  var container = document.getElementById('diagram-container');

  container.addEventListener('mousedown', function(e){
    var card = e.target.closest('.node-card');
    if(!card) return;
    // Don't start drag if clicking on editable text
    if(e.target.isContentEditable || e.target.closest('[contenteditable]')) return;

    e.preventDefault();
    e.stopPropagation();

    card.classList.add('dragging');
    dragState = {
      card: card,
      nodeId: card.dataset.nodeId,
      startLeft: parseInt(card.style.left),
      startTop: parseInt(card.style.top),
      startMouseX: e.clientX / scale,
      startMouseY: e.clientY / scale
    };
  });

  window.addEventListener('mousemove', function(e){
    if(!dragState) return;
    e.preventDefault();
    var dx = (e.clientX / scale) - dragState.startMouseX;
    var dy = (e.clientY / scale) - dragState.startMouseY;
    var newLeft = dragState.startLeft + dx;
    var newTop = dragState.startTop + dy;
    dragState.card.style.left = newLeft + 'px';
    dragState.card.style.top = newTop + 'px';

    // Update live positions
    livePositions[dragState.nodeId] = {
      x: newLeft,
      y: newTop,
      cx: newLeft + NODE_WIDTH / 2,
      cy: newTop + NODE_HEIGHT / 2
    };

    // Redraw edges in realtime
    redrawEdges();
  });

  window.addEventListener('mouseup', function(){
    if(!dragState) return;
    dragState.card.classList.remove('dragging');
    // Expand diagram container if card was dragged outside bounds
    expandContainer();
    dragState = null;
  });
}

function expandContainer(){
  var container = document.getElementById('diagram-container');
  var svg = document.getElementById('edges-svg');
  var maxR = 0, maxB = 0;
  container.querySelectorAll('.node-card').forEach(function(card){
    var r = parseInt(card.style.left) + card.offsetWidth + 40;
    var b = parseInt(card.style.top) + card.offsetHeight + 40;
    if(r > maxR) maxR = r;
    if(b > maxB) maxB = b;
  });
  container.style.width = maxR + 'px';
  container.style.height = maxB + 'px';
  svg.setAttribute('width', maxR);
  svg.setAttribute('height', maxB);
  svg.style.width = maxR + 'px';
  svg.style.height = maxB + 'px';
}

function getNodePosition(nodeId){
  if(livePositions[nodeId]) return livePositions[nodeId];
  // Find from DOM
  var card = document.querySelector('.node-card[data-node-id="'+nodeId+'"]');
  if(!card) return null;
  var x = parseInt(card.style.left), y = parseInt(card.style.top);
  return { x: x, y: y, cx: x + NODE_WIDTH/2, cy: y + NODE_HEIGHT/2 };
}

function redrawEdges(){
  var svg = document.getElementById('edges-svg');
  var container = document.getElementById('diagram-container');
  var defs = svg.querySelector('defs');
  svg.innerHTML = '';
  svg.appendChild(defs);

  // Remove old edge labels
  container.querySelectorAll('.edge-label').forEach(function(el){ el.remove(); });

  EDGES.forEach(function(e){
    var from = getNodePosition(e.from);
    var to = getNodePosition(e.to);
    if(!from || !to) return;

    var sx, sy, ex, ey;
    if(currentDirection === 'LR'){
      sx = from.cx + NODE_WIDTH/2; sy = from.cy;
      ex = to.cx - NODE_WIDTH/2; ey = to.cy;
    } else {
      sx = from.cx; sy = from.cy + NODE_HEIGHT/2;
      ex = to.cx; ey = to.cy - NODE_HEIGHT/2;
    }

    // Simple curve through midpoint
    var mx = (sx + ex) / 2, my = (sy + ey) / 2;
    var d = 'M '+sx+' '+sy+' Q '+mx+' '+sy+' '+mx+' '+my;
    d += ' Q '+mx+' '+ey+' '+ex+' '+ey;

    var pathEl = document.createElementNS('http://www.w3.org/2000/svg','path');
    pathEl.setAttribute('d', d);
    pathEl.setAttribute('class', 'edge-line');
    pathEl.setAttribute('marker-end', 'url(#arrowhead)');
    svg.appendChild(pathEl);

    // Edge label
    var label = e.label || '';
    if(label){
      var edgeKey = e.from + '-' + e.to;
      var lbl = document.createElement('div');
      lbl.className = 'edge-label' + (labelsVisible ? '' : ' hidden');
      lbl.contentEditable = 'true';
      lbl.textContent = edgeEdits[edgeKey] || label;
      lbl.dataset.edgeKey = edgeKey;
      lbl.style.left = mx + 'px';
      lbl.style.top = my + 'px';
      lbl.addEventListener('blur', function(){ edgeEdits[this.dataset.edgeKey] = this.textContent.trim(); });
      lbl.addEventListener('keydown', function(ev){ if(ev.key==='Enter'){ev.preventDefault();this.blur();} });
      container.appendChild(lbl);
    }
  });
}

// ── Level navigation ──
function updateLevelDisplay(){
  var display = document.getElementById('level-display');
  if(currentLevel<0) display.textContent = 'All';
  else display.textContent = 'Level '+(currentLevel+1)+'/'+levelRanks.length;
}

function panToLevel(levelIdx){
  if(levelRanks.length===0) return;
  currentLevel = levelIdx;
  updateLevelDisplay();

  if(levelIdx < 0){ zoomFit(); return; }

  var level = levelRanks[levelIdx];
  if(!level) return;

  // Find center of nodes at this level
  var cards = document.querySelectorAll('.node-card');
  var minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  var found = false;

  cards.forEach(function(card){
    var nid = card.dataset.nodeId;
    if(level.nodeIds.indexOf(nid)>=0){
      var l=parseInt(card.style.left),t=parseInt(card.style.top);
      var w=card.offsetWidth,h=card.offsetHeight;
      if(l<minX)minX=l; if(l+w>maxX)maxX=l+w;
      if(t<minY)minY=t; if(t+h>maxY)maxY=t+h;
      found=true;
    }
  });

  if(!found) return;

  var centerX=(minX+maxX)/2, centerY=(minY+maxY)/2;
  var vw=viewport.clientWidth, vh=viewport.clientHeight;

  // Calculate scale to fit the level's nodes
  var levelW = maxX-minX+80, levelH = maxY-minY+80;
  scale = Math.min(vw/levelW, vh/levelH, 1.5);

  panX = vw/2 - centerX*scale;
  panY = vh/2 - centerY*scale;
  applyTransform();
}

function prevLevel(){
  if(currentLevel <= 0) currentLevel = -1;
  else currentLevel--;
  panToLevel(currentLevel);
}

function nextLevel(){
  if(currentLevel < levelRanks.length-1) currentLevel++;
  panToLevel(currentLevel);
}

// ── Zoom & Pan ──
var scale=1,panX=0,panY=0,isPanning=false,startX,startY;
var ZOOM_STEP=0.15,MIN_SCALE=0.03,MAX_SCALE=5;
var viewport=document.getElementById('viewport');
var canvas=document.getElementById('canvas');

function applyTransform(){
  canvas.style.transform='translate('+panX+'px,'+panY+'px) scale('+scale+')';
  document.getElementById('zoom-level').textContent=Math.round(scale*100)+'%';
}
function zoomIn(){scale=Math.min(scale+ZOOM_STEP,MAX_SCALE);applyTransform()}
function zoomOut(){scale=Math.max(scale-ZOOM_STEP,MIN_SCALE);applyTransform()}
function zoomReset(){scale=1;panX=0;panY=0;applyTransform()}
function zoomFit(){
  var dc=document.getElementById('diagram-container');
  if(!dc)return;
  var vw=viewport.clientWidth,vh=viewport.clientHeight;
  var sw=parseInt(dc.style.width)||dc.scrollWidth,sh=parseInt(dc.style.height)||dc.scrollHeight;
  scale=Math.min(vw/(sw+20),vh/(sh+20),1);
  panX=Math.max(0,(vw-sw*scale)/2);
  panY=Math.max(0,(vh-sh*scale)/2);
  applyTransform();
}

viewport.addEventListener('wheel',function(e){
  e.preventDefault();
  var rect=viewport.getBoundingClientRect();
  var mx=e.clientX-rect.left,my=e.clientY-rect.top,os=scale;
  scale=e.deltaY<0?Math.min(scale*1.1,MAX_SCALE):Math.max(scale/1.1,MIN_SCALE);
  panX=mx-(mx-panX)*(scale/os);panY=my-(my-panY)*(scale/os);applyTransform();
},{passive:false});

viewport.addEventListener('mousedown',function(e){if(dragState)return;isPanning=true;startX=e.clientX-panX;startY=e.clientY-panY});
window.addEventListener('mousemove',function(e){if(!isPanning||dragState)return;panX=e.clientX-startX;panY=e.clientY-startY;applyTransform()});
window.addEventListener('mouseup',function(){isPanning=false});

var lastTouchDist=0;
viewport.addEventListener('touchstart',function(e){
  if(e.touches.length===1){isPanning=true;startX=e.touches[0].clientX-panX;startY=e.touches[0].clientY-panY}
  else if(e.touches.length===2){lastTouchDist=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY)}
},{passive:false});
viewport.addEventListener('touchmove',function(e){
  e.preventDefault();
  if(e.touches.length===1&&isPanning){panX=e.touches[0].clientX-startX;panY=e.touches[0].clientY-startY;applyTransform()}
  else if(e.touches.length===2){var d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);scale=Math.min(Math.max(scale*(d/lastTouchDist),MIN_SCALE),MAX_SCALE);lastTouchDist=d;applyTransform()}
},{passive:false});
viewport.addEventListener('touchend',function(){isPanning=false});

// ── Build SVG (shared by SVG/PNG export) ──
function buildExportSvg(){
  var container=document.getElementById('diagram-container');
  var edgeSvg=document.getElementById('edges-svg');
  if(!container||!edgeSvg)return null;
  var w=parseInt(container.style.width)||container.scrollWidth;
  var h=parseInt(container.style.height)||container.scrollHeight;
  var svgNs='http://www.w3.org/2000/svg',xlinkNs='http://www.w3.org/1999/xlink';
  var svg=document.createElementNS(svgNs,'svg');
  svg.setAttribute('xmlns',svgNs);svg.setAttribute('xmlns:xlink',xlinkNs);
  svg.setAttribute('width',w);svg.setAttribute('height',h);
  svg.setAttribute('viewBox','0 0 '+w+' '+h);
  svg.setAttribute('style','background:#fff;font-family:Arial,sans-serif;');

  var style=document.createElementNS(svgNs,'style');
  style.textContent='.edge-line{fill:none;stroke:#505a5f;stroke-width:1.5}.edge-arrow{fill:#505a5f}';
  svg.appendChild(style);
  var defs=edgeSvg.querySelector('defs');
  if(defs)svg.appendChild(defs.cloneNode(true));
  edgeSvg.querySelectorAll('path').forEach(function(p){svg.appendChild(p.cloneNode(true))});

  container.querySelectorAll('.node-card').forEach(function(card){
    var left=parseInt(card.style.left),top=parseInt(card.style.top);
    var cw=card.offsetWidth,ch=card.offsetHeight;
    var isChoice=card.classList.contains('choice'),isEnd=card.classList.contains('end-page');
    var bc=isChoice?'#1D70B8':isEnd?'#00703C':'#b1b4b6',bw=(isChoice||isEnd)?3:2;

    var rect=document.createElementNS(svgNs,'rect');
    rect.setAttribute('x',left);rect.setAttribute('y',top);rect.setAttribute('width',cw);rect.setAttribute('height',ch);
    rect.setAttribute('rx',6);rect.setAttribute('fill','#fff');rect.setAttribute('stroke',bc);rect.setAttribute('stroke-width',bw);
    svg.appendChild(rect);

    var img=card.querySelector('.node-thumb');
    if(img&&img.src){
      var si=document.createElementNS(svgNs,'image');
      si.setAttribute('x',left+bw);si.setAttribute('y',top+bw);si.setAttribute('width',220-bw*2);si.setAttribute('height',140);
      si.setAttributeNS(xlinkNs,'href',img.src);si.setAttribute('preserveAspectRatio','xMinYMin slice');
      svg.appendChild(si);
    }

    var titleEl=card.querySelector('.node-title');
    if(titleEl){
      var tt=document.createElementNS(svgNs,'text');
      tt.setAttribute('x',left+10);tt.setAttribute('y',top+158);tt.setAttribute('fill','#0b0c0c');
      var titleFontSize = currentTextSize==='s'?10:currentTextSize==='l'?15:12;
      tt.setAttribute('font-size',titleFontSize);tt.setAttribute('font-weight','700');
      var txt=titleEl.textContent.trim();if(txt.length>35)txt=txt.substring(0,32)+'...';
      tt.textContent=txt;svg.appendChild(tt);
    }

    var badges=card.querySelectorAll('.nb');var bx=left+10,by=top+175;
    badges.forEach(function(badge){
      var bww=badge.textContent.length*6+12;
      var bg=badge.classList.contains('nb-c')?'#1D70B8':badge.classList.contains('nb-e')?'#00703C':'#f3f2f1';
      var fg=bg==='#f3f2f1'?'#505a5f':'#fff';
      var br=document.createElementNS(svgNs,'rect');
      br.setAttribute('x',bx);br.setAttribute('y',by);br.setAttribute('width',bww);br.setAttribute('height',16);
      br.setAttribute('rx',3);br.setAttribute('fill',bg);svg.appendChild(br);
      var bt=document.createElementNS(svgNs,'text');
      bt.setAttribute('x',bx+6);bt.setAttribute('y',by+12);bt.setAttribute('fill',fg);
      bt.setAttribute('font-size','10');bt.setAttribute('font-weight','700');bt.textContent=badge.textContent;
      svg.appendChild(bt);bx+=bww+4;
    });
  });

  // Edge labels (if visible)
  if(labelsVisible){
    container.querySelectorAll('.edge-label:not(.hidden)').forEach(function(lbl){
      var lx=parseInt(lbl.style.left),ly=parseInt(lbl.style.top);
      var lw=lbl.offsetWidth,lh=lbl.offsetHeight;
      var rx=lx-lw/2-2,ry=ly-lh/2-2;
      var bg=document.createElementNS(svgNs,'rect');
      bg.setAttribute('x',rx);bg.setAttribute('y',ry);bg.setAttribute('width',lw+4);bg.setAttribute('height',lh+4);
      bg.setAttribute('rx',3);bg.setAttribute('fill','rgba(255,255,255,0.92)');bg.setAttribute('stroke','#e0e0e0');bg.setAttribute('stroke-width','1');
      svg.appendChild(bg);
      var lt=document.createElementNS(svgNs,'text');
      lt.setAttribute('x',lx);lt.setAttribute('y',ly+4);lt.setAttribute('text-anchor','middle');
      lt.setAttribute('fill','#505a5f');var lblFs=currentTextSize==='s'?8:currentTextSize==='l'?13:10;lt.setAttribute('font-size',lblFs);lt.textContent=lbl.textContent;
      svg.appendChild(lt);
    });
  }

  return svg;
}

// ── SVG Export ──
function exportSvg(){
  var svg=buildExportSvg();if(!svg)return;
  var blob=new Blob([new XMLSerializer().serializeToString(svg)],{type:'image/svg+xml;charset=utf-8'});
  downloadBlob(blob,'journey-map.svg');
}

// ── PNG Export ──
function exportPng(){
  var svg=buildExportSvg();if(!svg)return;
  var svgStr=new XMLSerializer().serializeToString(svg);
  var w=parseInt(svg.getAttribute('width')),h=parseInt(svg.getAttribute('height'));

  // Render at 2x for high-res
  var canvas2=document.createElement('canvas');
  canvas2.width=w*2;canvas2.height=h*2;
  var ctx=canvas2.getContext('2d');
  ctx.scale(2,2);

  var img=new Image();
  img.onload=function(){
    ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);
    ctx.drawImage(img,0,0,w,h);
    canvas2.toBlob(function(blob){downloadBlob(blob,'journey-map.png')},'image/png');
  };
  img.onerror=function(){
    alert('PNG export failed. Try SVG export instead.');
  };
  img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svgStr);
}

// ── PDF Export ──
function exportPdf(){
  // Use browser print with the print stylesheet
  window.print();
}

function downloadBlob(blob,filename){
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');a.href=url;a.download=filename;
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Tabs / Lightbox ──
function showTab(name){
  document.querySelectorAll('.panel').forEach(function(p){p.classList.remove('active')});
  document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active')});
  document.getElementById(name).classList.add('active');
  event.target.classList.add('active');
}
function openLightbox(src){document.getElementById('lightbox-img').src=src;document.getElementById('lightbox').classList.add('active')}
function closeLightbox(){document.getElementById('lightbox').classList.remove('active')}

// ── Init ──
document.addEventListener('DOMContentLoaded',function(){
  renderDiagram();
  initDrag();
  setTimeout(zoomFit,200);
});
</` + `script>
</body>
</html>`;
}

function escapeHtml(text) {
  return (text||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

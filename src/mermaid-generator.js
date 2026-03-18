import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

/**
 * Generate diagram outputs from crawl data:
 *   - .mmd file (Mermaid source, LR orientation)
 *   - .html file (custom interactive diagram with screenshots, zoom/pan)
 *   - .pdf file (rendered from HTML for Mural import)
 */
export async function generateMermaid(crawlData, outputDir) {
  const { pages, edges } = crawlData;
  const outputPath = path.join(outputDir, 'journey-map.mmd');
  const htmlOutputPath = path.join(outputDir, 'journey-map.html');
  const pdfOutputPath = path.join(outputDir, 'journey-map.pdf');

  // --- 1. Generate .mmd file (LR orientation) ---
  const mermaidContent = generateMermaidSource(crawlData);
  fs.writeFileSync(outputPath, mermaidContent);
  console.log(`📊 Mermaid diagram saved: ${outputPath}`);

  // --- 2. Generate interactive HTML with screenshot nodes ---
  const htmlContent = generateHtml(crawlData, outputDir);
  fs.writeFileSync(htmlOutputPath, htmlContent);
  console.log(`🌐 Interactive HTML map saved: ${htmlOutputPath}`);

  // --- 3. Render PDF from HTML ---
  console.log(`📄 Rendering PDF...`);
  try {
    const browser = await chromium.launch({
      headless: true,
      channel: 'chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(`file://${path.resolve(htmlOutputPath)}`, {
      waitUntil: 'networkidle',
      timeout: 60000
    });

    // Wait for the diagram to fully render
    await page.waitForSelector('.node-card', { timeout: 20000 }).catch(() => {
      console.warn('  ⚠ Diagram nodes not detected, PDF may be incomplete');
    });
    await page.waitForTimeout(2000);

    // Prepare for PDF: reset zoom, expand viewport, hide controls
    await page.evaluate(() => {
      const canvas = document.getElementById('canvas');
      const viewport = document.getElementById('viewport');
      if (canvas) canvas.style.transform = 'none';
      if (viewport) {
        viewport.style.height = 'auto';
        viewport.style.overflow = 'visible';
        viewport.style.cursor = 'default';
      }
      document.querySelectorAll('.zoom-controls, .tabs').forEach(el => {
        el.style.display = 'none';
      });
      const sp = document.getElementById('screenshots');
      if (sp) sp.style.display = 'none';
    });

    // Measure diagram size
    const diagramSize = await page.evaluate(() => {
      const container = document.getElementById('diagram-container');
      if (container) {
        return { width: container.scrollWidth, height: container.scrollHeight };
      }
      return null;
    });

    let pdfWidth = '594mm'; // A1 landscape default
    let pdfHeight = '420mm';

    if (diagramSize) {
      const widthMm = Math.ceil((diagramSize.width / 96) * 25.4) + 60;
      const heightMm = Math.ceil((diagramSize.height / 96) * 25.4) + 60;
      pdfWidth = `${Math.max(widthMm, 420)}mm`;
      pdfHeight = `${Math.max(heightMm, 297)}mm`;
    }

    await page.pdf({
      path: pdfOutputPath,
      width: pdfWidth,
      height: pdfHeight,
      printBackground: true,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
    });

    await browser.close();
    console.log(`📄 PDF saved: ${pdfOutputPath}`);
  } catch (err) {
    console.warn(`  ⚠ PDF generation failed: ${err.message}`);
    console.warn(`    The HTML file is still available at: ${htmlOutputPath}`);
  }

  return { mermaidPath: outputPath, htmlPath: htmlOutputPath, pdfPath: pdfOutputPath };
}

// ──────────────────────────────────────────────
// Mermaid .mmd source (LR orientation)
// ──────────────────────────────────────────────
function generateMermaidSource(crawlData) {
  const { pages, edges } = crawlData;
  const lines = ['flowchart LR'];
  lines.push('');

  const nodeIds = new Map();
  let counter = 0;
  function nid(url) {
    if (!nodeIds.has(url)) nodeIds.set(url, `p${counter++}`);
    return nodeIds.get(url);
  }
  function sanitize(text) {
    return (text || 'Unknown').replace(/"/g, "'").replace(/[<>]/g, '').replace(/\n/g, ' ').substring(0, 60);
  }

  const definedNodes = new Set();
  for (const [url, pd] of pages) {
    const id = nid(url);
    const label = sanitize(pd.pageName || pd.h1 || url);
    const fc = pd.fields.length;
    if (pd.isEndPage) {
      lines.push(`  ${id}(["${label} | ${fc} fields"])`);
    } else if (pd.choicePoints.length > 0) {
      lines.push(`  ${id}{{"${label} | ${fc} fields | ${pd.choicePoints.length} choices"}}`);
    } else {
      lines.push(`  ${id}["${label}${fc > 0 ? ' | ' + fc + ' fields' : ''}"]`);
    }
    definedNodes.add(id);
  }

  lines.push('');

  const edgeSet = new Set();
  for (const edge of edges) {
    const fid = nid(edge.from);
    const tid = nid(edge.to);
    const key = `${fid}-${tid}-${edge.label}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);
    if (definedNodes.has(fid) && definedNodes.has(tid)) {
      const label = sanitize(edge.label);
      if (label && label !== 'continue') {
        lines.push(`  ${fid} -->|"${label}"| ${tid}`);
      } else {
        lines.push(`  ${fid} --> ${tid}`);
      }
    }
  }

  lines.push('');
  lines.push('  %% Styling');
  lines.push('  classDef endPage fill:#00703C,stroke:#00703C,color:#fff');
  lines.push('  classDef choicePage fill:#1D70B8,stroke:#1D70B8,color:#fff');
  lines.push('  classDef normalPage fill:#f3f2f1,stroke:#505a5f,color:#0b0c0c');
  lines.push('');

  for (const [url, pd] of pages) {
    const id = nid(url);
    if (pd.isEndPage) lines.push(`  class ${id} endPage`);
    else if (pd.choicePoints.length > 0) lines.push(`  class ${id} choicePage`);
    else lines.push(`  class ${id} normalPage`);
  }

  return lines.join('\n');
}

// ──────────────────────────────────────────────
// Interactive HTML with dagre layout + screenshots
// ──────────────────────────────────────────────
function generateHtml(crawlData, outputDir) {
  const { pages, edges, screenshots } = crawlData;
  const formTitle = escapeHtml(crawlData.formTitle || 'Form Journey Map');

  // Build graph data structure for dagre
  const nodes = [];
  const graphEdges = [];
  const nodeIdMap = new Map();
  let idx = 0;

  for (const [url, pd] of pages) {
    const nodeId = `n${idx++}`;
    nodeIdMap.set(url, nodeId);

    // Base64 encode screenshot if available
    let screenshotB64 = '';
    const ssPath = screenshots.get(url);
    if (ssPath && fs.existsSync(ssPath)) {
      try {
        const buf = fs.readFileSync(ssPath);
        screenshotB64 = buf.toString('base64');
      } catch { /* skip */ }
    }

    nodes.push({
      id: nodeId,
      label: (pd.pageName || pd.h1 || url).substring(0, 80),
      url: pd.url,
      fieldCount: pd.fields.length,
      choiceCount: pd.choicePoints.length,
      isEndPage: pd.isEndPage,
      screenshot: screenshotB64
    });
  }

  // Deduplicate edges
  const edgeSet = new Set();
  for (const edge of edges) {
    const fromId = nodeIdMap.get(edge.from);
    const toId = nodeIdMap.get(edge.to);
    if (!fromId || !toId) continue;
    const label = (edge.label || '').substring(0, 50);
    const key = `${fromId}-${toId}-${label}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);
    graphEdges.push({ from: fromId, to: toId, label: label === 'continue' ? '' : label });
  }

  // Build screenshot gallery index
  const pageIndex = [];
  for (const [url, pd] of pages) {
    const ssPath = screenshots.get(url);
    pageIndex.push({
      name: pd.pageName || url,
      url: pd.url,
      fieldCount: pd.fields.length,
      isEndPage: pd.isEndPage,
      screenshot: ssPath ? path.basename(ssPath) : null
    });
  }

  const nodesJson = JSON.stringify(nodes);
  const edgesJson = JSON.stringify(graphEdges);

  const galleryHtml = pageIndex.map(p => {
    const ssImg = p.screenshot ? `<img src="screenshots/${p.screenshot}" alt="${escapeHtml(p.name)}" onclick="openLightbox(this.src)">` : '';
    const badges = [
      p.fieldCount > 0 ? `<span class="gallery-badge gallery-badge-fields">${p.fieldCount} fields</span>` : '',
      p.isEndPage ? '<span class="gallery-badge gallery-badge-end">End page</span>' : ''
    ].filter(Boolean).join(' ');
    return `<div class="card">${ssImg}<div class="card-body"><h3>${escapeHtml(p.name)}</h3><p>${escapeHtml(p.url)}</p><div style="margin-top:8px">${badges}</div></div></div>`;
  }).join('\n      ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${formTitle} — Journey Map</title>
  <script src="https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js"></` + `script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: "GDS Transport", Arial, sans-serif; background: #f3f2f1; color: #0b0c0c; }
    .header { background: #0b0c0c; color: #fff; padding: 16px 24px; }
    .header h1 { font-size: 24px; font-weight: 700; }
    .header p { color: #b1b4b6; margin-top: 4px; font-size: 14px; }
    .tabs { display: flex; background: #fff; border-bottom: 1px solid #b1b4b6; padding: 0 24px; }
    .tab { padding: 12px 20px; cursor: pointer; font-size: 16px; border-bottom: 4px solid transparent; color: #1d70b8; user-select: none; }
    .tab:hover { color: #003078; }
    .tab.active { border-bottom-color: #1d70b8; color: #0b0c0c; font-weight: 700; }
    .panel { display: none; padding: 24px; }
    .panel.active { display: block; }

    .zoom-controls { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
    .zoom-btn {
      background: #fff; border: 1px solid #b1b4b6; border-radius: 4px;
      padding: 6px 14px; cursor: pointer; font-size: 16px; font-weight: 700;
      color: #1d70b8; line-height: 1;
    }
    .zoom-btn:hover { background: #f3f2f1; color: #003078; }
    .zoom-level { font-size: 13px; color: #505a5f; min-width: 50px; text-align: center; }

    .mermaid-viewport {
      background: #fff; border: 1px solid #b1b4b6; border-radius: 4px;
      overflow: hidden; position: relative; height: 75vh; cursor: grab;
    }
    .mermaid-viewport:active { cursor: grabbing; }
    .mermaid-canvas { transform-origin: 0 0; position: absolute; top: 0; left: 0; }

    #diagram-container { position: relative; }
    .node-card {
      position: absolute; background: #fff; border: 2px solid #b1b4b6;
      border-radius: 6px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.08);
      cursor: default; transition: box-shadow 0.15s;
    }
    .node-card:hover { box-shadow: 0 2px 12px rgba(0,0,0,0.15); }
    .node-card.choice { border-color: #1D70B8; border-width: 3px; }
    .node-card.end-page { border-color: #00703C; border-width: 3px; }
    .node-thumb {
      width: 220px; height: 140px; object-fit: cover; object-position: top left;
      display: block; border-bottom: 1px solid #e0e0e0; background: #f8f8f8;
    }
    .node-thumb-placeholder {
      width: 220px; height: 140px; display: flex; align-items: center; justify-content: center;
      background: #f3f2f1; color: #b1b4b6; font-size: 12px; border-bottom: 1px solid #e0e0e0;
    }
    .node-info { padding: 8px 10px; max-width: 220px; }
    .node-title {
      font-size: 12px; font-weight: 700; color: #0b0c0c; line-height: 1.3;
      max-height: 3.9em; overflow: hidden;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    }
    .node-meta { font-size: 11px; color: #505a5f; margin-top: 4px; }
    .node-badge {
      display: inline-block; padding: 1px 6px; font-size: 10px;
      border-radius: 3px; font-weight: 700; margin-right: 4px;
    }
    .badge-choice { background: #1D70B8; color: #fff; }
    .badge-end { background: #00703C; color: #fff; }
    .badge-fields { background: #f3f2f1; color: #505a5f; border: 1px solid #b1b4b6; }

    .edge-label {
      position: absolute; font-size: 10px; color: #505a5f;
      background: rgba(255,255,255,0.92); padding: 2px 6px; border-radius: 3px;
      pointer-events: none; max-width: 120px; width: max-content;
      text-align: center; line-height: 1.3; word-wrap: break-word;
      border: 1px solid #e0e0e0; transform: translate(-50%, -50%);
    }
    .edge-line { fill: none; stroke: #505a5f; stroke-width: 1.5; }
    .edge-arrow { fill: #505a5f; }

    .stats { display: flex; gap: 24px; margin-bottom: 20px; }
    .stat {
      background: #fff; padding: 16px 24px; border: 1px solid #b1b4b6;
      border-radius: 4px; border-left: 4px solid #1d70b8;
    }
    .stat-value { font-size: 28px; font-weight: 700; }
    .stat-label { font-size: 14px; color: #505a5f; }

    .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 20px; }
    .card { background: #fff; border: 1px solid #b1b4b6; border-radius: 4px; overflow: hidden; }
    .card img { width: 100%; border-bottom: 1px solid #b1b4b6; cursor: pointer; }
    .card-body { padding: 12px 16px; }
    .card-body h3 { font-size: 16px; margin-bottom: 4px; }
    .card-body p { font-size: 14px; color: #505a5f; }
    .gallery-badge { display: inline-block; padding: 2px 8px; font-size: 12px; border-radius: 3px; font-weight: 700; }
    .gallery-badge-end { background: #00703C; color: #fff; }
    .gallery-badge-fields { background: #1d70b8; color: #fff; }

    .lightbox {
      display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.85); z-index: 1000;
      justify-content: center; align-items: center; cursor: pointer;
    }
    .lightbox.active { display: flex; }
    .lightbox img { max-width: 90vw; max-height: 90vh; border: 2px solid #fff; border-radius: 4px; }

    @media print {
      body { background: #fff; }
      .tabs, .lightbox, .zoom-controls { display: none !important; }
      .panel { display: block !important; padding: 10px; }
      #screenshots { display: none !important; }
      .header { background: #0b0c0c; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .mermaid-viewport { border: none; overflow: visible; height: auto; cursor: default; }
      .mermaid-canvas { transform: none !important; position: relative; }
      .stat, .node-card, .badge-choice, .badge-end, .badge-fields, .node-badge, .gallery-badge, .gallery-badge-end, .gallery-badge-fields {
        -webkit-print-color-adjust: exact; print-color-adjust: exact;
      }
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
    <div class="zoom-controls">
      <button class="zoom-btn" onclick="zoomIn()" title="Zoom in">+</button>
      <button class="zoom-btn" onclick="zoomOut()" title="Zoom out">&minus;</button>
      <button class="zoom-btn" onclick="zoomFit()" title="Fit to view">Fit</button>
      <button class="zoom-btn" onclick="zoomReset()" title="Reset to 100%">1:1</button>
      <span class="zoom-level" id="zoom-level">100%</span>
      <span style="border-left: 1px solid #b1b4b6; height: 24px; margin: 0 8px;"></span>
      <button class="zoom-btn" onclick="exportSvg()" title="Download as SVG" style="font-weight:400;font-size:13px;">&#11015; SVG</button>
    </div>
    <div class="mermaid-viewport" id="viewport">
      <div class="mermaid-canvas" id="canvas">
        <svg id="edges-svg" style="position:absolute;top:0;left:0;pointer-events:none;overflow:visible;">
          <defs>
            <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
              <polygon points="0 0, 10 3.5, 0 7" class="edge-arrow"/>
            </marker>
          </defs>
        </svg>
        <div id="diagram-container"></div>
      </div>
    </div>
  </div>

  <div id="screenshots" class="panel">
    <div class="gallery">
      ${galleryHtml}
    </div>
  </div>

  <div class="lightbox" id="lightbox" onclick="closeLightbox()">
    <img id="lightbox-img" src="" alt="Screenshot">
  </div>

  <` + `script>
    // ── Graph data ──
    var NODES = ${nodesJson};
    var EDGES = ${edgesJson};

    // ── Layout with dagre ──
    var NODE_WIDTH = 224;
    var NODE_HEIGHT = 206;

    function layoutGraph() {
      var g = new dagre.graphlib.Graph();
      g.setGraph({
        rankdir: 'LR',
        nodesep: 50,
        ranksep: 140,
        marginx: 40,
        marginy: 40
      });
      g.setDefaultEdgeLabel(function() { return {}; });

      NODES.forEach(function(n) {
        g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
      });
      EDGES.forEach(function(e) {
        g.setEdge(e.from, e.to, { label: e.label || '' });
      });

      dagre.layout(g);
      return g;
    }

    function renderDiagram() {
      var g = layoutGraph();
      var container = document.getElementById('diagram-container');
      var svg = document.getElementById('edges-svg');
      container.innerHTML = '';

      var graph = g.graph();
      var totalW = graph.width + 80;
      var totalH = graph.height + 80;
      container.style.width = totalW + 'px';
      container.style.height = totalH + 'px';
      svg.setAttribute('width', totalW);
      svg.setAttribute('height', totalH);
      svg.style.width = totalW + 'px';
      svg.style.height = totalH + 'px';

      // Render nodes
      var nodePositions = {};
      g.nodes().forEach(function(id) {
        var layout = g.node(id);
        var node = NODES.find(function(n) { return n.id === id; });
        if (!node || !layout) return;

        var x = layout.x - NODE_WIDTH / 2;
        var y = layout.y - NODE_HEIGHT / 2;
        nodePositions[id] = { x: x, y: y, w: NODE_WIDTH, h: NODE_HEIGHT, cx: layout.x, cy: layout.y };

        var card = document.createElement('div');
        card.className = 'node-card' + (node.choiceCount > 0 ? ' choice' : '') + (node.isEndPage ? ' end-page' : '');
        card.style.left = x + 'px';
        card.style.top = y + 'px';
        card.style.width = NODE_WIDTH + 'px';

        if (node.screenshot) {
          var img = document.createElement('img');
          img.className = 'node-thumb';
          img.src = 'data:image/png;base64,' + node.screenshot;
          img.alt = node.label;
          card.appendChild(img);
        } else {
          var ph = document.createElement('div');
          ph.className = 'node-thumb-placeholder';
          ph.textContent = 'No screenshot';
          card.appendChild(ph);
        }

        var info = document.createElement('div');
        info.className = 'node-info';

        var title = document.createElement('div');
        title.className = 'node-title';
        title.textContent = node.label;
        info.appendChild(title);

        var meta = document.createElement('div');
        meta.className = 'node-meta';
        if (node.choiceCount > 0) meta.innerHTML += '<span class="node-badge badge-choice">' + node.choiceCount + ' choice' + (node.choiceCount > 1 ? 's' : '') + '</span>';
        if (node.isEndPage) meta.innerHTML += '<span class="node-badge badge-end">End</span>';
        if (node.fieldCount > 0) meta.innerHTML += '<span class="node-badge badge-fields">' + node.fieldCount + ' field' + (node.fieldCount > 1 ? 's' : '') + '</span>';
        info.appendChild(meta);
        card.appendChild(info);
        container.appendChild(card);
      });

      // Render edges
      var defs = svg.querySelector('defs');
      svg.innerHTML = '';
      svg.appendChild(defs);

      g.edges().forEach(function(e) {
        var edgeData = g.edge(e);
        var from = nodePositions[e.v];
        var to = nodePositions[e.w];
        if (!from || !to || !edgeData) return;

        var points = edgeData.points || [];

        // Clamp start/end to card edges
        var sx = from.cx + from.w / 2;
        var sy = from.cy;
        var ex = to.cx - to.w / 2;
        var ey = to.cy;

        var d;
        if (points.length >= 2) {
          d = 'M ' + sx + ' ' + sy;
          // Use smooth curve via intermediate dagre points
          for (var i = 1; i < points.length - 1; i++) {
            var p = points[i];
            if (i === points.length - 2) {
              d += ' Q ' + p.x + ' ' + p.y + ' ' + ex + ' ' + ey;
            } else {
              var next = points[i + 1];
              var mx = (p.x + next.x) / 2;
              var my = (p.y + next.y) / 2;
              d += ' Q ' + p.x + ' ' + p.y + ' ' + mx + ' ' + my;
            }
          }
          if (points.length === 2) {
            d += ' L ' + ex + ' ' + ey;
          }
        } else {
          d = 'M ' + sx + ' ' + sy + ' L ' + ex + ' ' + ey;
        }

        var pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        pathEl.setAttribute('d', d);
        pathEl.setAttribute('class', 'edge-line');
        pathEl.setAttribute('marker-end', 'url(#arrowhead)');
        svg.appendChild(pathEl);

        // Edge label
        var label = edgeData.label || '';
        if (label) {
          var midIdx = Math.floor(points.length / 2);
          var midPt = points[midIdx] || { x: (sx + ex) / 2, y: (sy + ey) / 2 };
          var labelEl = document.createElement('div');
          labelEl.className = 'edge-label';
          labelEl.textContent = label;
          labelEl.style.left = midPt.x + 'px';
          labelEl.style.top = midPt.y + 'px';
          container.appendChild(labelEl);
        }
      });
    }

    // ── Zoom & Pan ──
    var scale = 1, panX = 0, panY = 0;
    var isPanning = false, startX, startY;
    var ZOOM_STEP = 0.15, MIN_SCALE = 0.05, MAX_SCALE = 5;
    var viewport = document.getElementById('viewport');
    var canvas = document.getElementById('canvas');
    var zoomLabel = document.getElementById('zoom-level');

    function applyTransform() {
      canvas.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
      zoomLabel.textContent = Math.round(scale * 100) + '%';
    }
    function zoomIn() { scale = Math.min(scale + ZOOM_STEP, MAX_SCALE); applyTransform(); }
    function zoomOut() { scale = Math.max(scale - ZOOM_STEP, MIN_SCALE); applyTransform(); }
    function zoomReset() { scale = 1; panX = 0; panY = 0; applyTransform(); }
    function zoomFit() {
      var dc = document.getElementById('diagram-container');
      if (!dc) return;
      var vw = viewport.clientWidth;
      var vh = viewport.clientHeight;
      var sw = parseInt(dc.style.width) || dc.scrollWidth;
      var sh = parseInt(dc.style.height) || dc.scrollHeight;
      scale = Math.min(vw / (sw + 20), vh / (sh + 20), 1);
      panX = Math.max(0, (vw - sw * scale) / 2);
      panY = Math.max(0, (vh - sh * scale) / 2);
      applyTransform();
    }

    viewport.addEventListener('wheel', function(e) {
      e.preventDefault();
      var rect = viewport.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      var oldScale = scale;
      scale = e.deltaY < 0 ? Math.min(scale * 1.1, MAX_SCALE) : Math.max(scale / 1.1, MIN_SCALE);
      panX = mx - (mx - panX) * (scale / oldScale);
      panY = my - (my - panY) * (scale / oldScale);
      applyTransform();
    }, { passive: false });

    viewport.addEventListener('mousedown', function(e) {
      isPanning = true; startX = e.clientX - panX; startY = e.clientY - panY;
    });
    window.addEventListener('mousemove', function(e) {
      if (!isPanning) return;
      panX = e.clientX - startX; panY = e.clientY - startY; applyTransform();
    });
    window.addEventListener('mouseup', function() { isPanning = false; });

    var lastTouchDist = 0;
    viewport.addEventListener('touchstart', function(e) {
      if (e.touches.length === 1) {
        isPanning = true; startX = e.touches[0].clientX - panX; startY = e.touches[0].clientY - panY;
      } else if (e.touches.length === 2) {
        lastTouchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      }
    }, { passive: false });
    viewport.addEventListener('touchmove', function(e) {
      e.preventDefault();
      if (e.touches.length === 1 && isPanning) {
        panX = e.touches[0].clientX - startX; panY = e.touches[0].clientY - startY; applyTransform();
      } else if (e.touches.length === 2) {
        var dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        scale = Math.min(Math.max(scale * (dist / lastTouchDist), MIN_SCALE), MAX_SCALE);
        lastTouchDist = dist; applyTransform();
      }
    }, { passive: false });
    viewport.addEventListener('touchend', function() { isPanning = false; });

    // ── SVG Export ──
    function exportSvg() {
      var container = document.getElementById('diagram-container');
      var edgeSvg = document.getElementById('edges-svg');
      if (!container || !edgeSvg) return;

      var w = parseInt(container.style.width) || container.scrollWidth;
      var h = parseInt(container.style.height) || container.scrollHeight;

      // Build a standalone SVG
      var svgNs = 'http://www.w3.org/2000/svg';
      var xlinkNs = 'http://www.w3.org/1999/xlink';
      var svg = document.createElementNS(svgNs, 'svg');
      svg.setAttribute('xmlns', svgNs);
      svg.setAttribute('xmlns:xlink', xlinkNs);
      svg.setAttribute('width', w);
      svg.setAttribute('height', h);
      svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
      svg.setAttribute('style', 'background:#fff;font-family:Arial,sans-serif;');

      // Add embedded styles
      var style = document.createElementNS(svgNs, 'style');
      style.textContent = [
        '.edge-line { fill: none; stroke: #505a5f; stroke-width: 1.5; }',
        '.edge-arrow { fill: #505a5f; }'
      ].join('\\n');
      svg.appendChild(style);

      // Copy defs (arrowhead marker)
      var defs = edgeSvg.querySelector('defs');
      if (defs) svg.appendChild(defs.cloneNode(true));

      // Copy edge paths
      edgeSvg.querySelectorAll('path').forEach(function(p) {
        svg.appendChild(p.cloneNode(true));
      });

      // Render each node card as SVG foreignObject
      container.querySelectorAll('.node-card').forEach(function(card) {
        var left = parseInt(card.style.left);
        var top = parseInt(card.style.top);
        var cw = card.offsetWidth;
        var ch = card.offsetHeight;

        // Card background rect
        var isChoice = card.classList.contains('choice');
        var isEnd = card.classList.contains('end-page');
        var borderColor = isChoice ? '#1D70B8' : isEnd ? '#00703C' : '#b1b4b6';
        var borderW = (isChoice || isEnd) ? 3 : 2;

        var rect = document.createElementNS(svgNs, 'rect');
        rect.setAttribute('x', left);
        rect.setAttribute('y', top);
        rect.setAttribute('width', cw);
        rect.setAttribute('height', ch);
        rect.setAttribute('rx', 6);
        rect.setAttribute('fill', '#fff');
        rect.setAttribute('stroke', borderColor);
        rect.setAttribute('stroke-width', borderW);
        svg.appendChild(rect);

        // Screenshot image
        var img = card.querySelector('.node-thumb');
        if (img && img.src) {
          var svgImg = document.createElementNS(svgNs, 'image');
          svgImg.setAttribute('x', left + borderW);
          svgImg.setAttribute('y', top + borderW);
          svgImg.setAttribute('width', 220 - borderW * 2);
          svgImg.setAttribute('height', 140);
          svgImg.setAttributeNS(xlinkNs, 'href', img.src);
          svgImg.setAttribute('preserveAspectRatio', 'xMinYMin slice');
          svg.appendChild(svgImg);
        } else {
          // Placeholder
          var ph = document.createElementNS(svgNs, 'rect');
          ph.setAttribute('x', left + borderW);
          ph.setAttribute('y', top + borderW);
          ph.setAttribute('width', 220 - borderW * 2);
          ph.setAttribute('height', 140);
          ph.setAttribute('fill', '#f3f2f1');
          svg.appendChild(ph);
          var phText = document.createElementNS(svgNs, 'text');
          phText.setAttribute('x', left + 110);
          phText.setAttribute('y', top + 75);
          phText.setAttribute('text-anchor', 'middle');
          phText.setAttribute('fill', '#b1b4b6');
          phText.setAttribute('font-size', '12');
          phText.textContent = 'No screenshot';
          svg.appendChild(phText);
        }

        // Title text
        var titleEl = card.querySelector('.node-title');
        if (titleEl) {
          var titleText = document.createElementNS(svgNs, 'text');
          titleText.setAttribute('x', left + 10);
          titleText.setAttribute('y', top + 158);
          titleText.setAttribute('fill', '#0b0c0c');
          titleText.setAttribute('font-size', '12');
          titleText.setAttribute('font-weight', '700');
          // Truncate to fit
          var txt = titleEl.textContent.trim();
          if (txt.length > 35) txt = txt.substring(0, 32) + '...';
          titleText.textContent = txt;
          svg.appendChild(titleText);
        }

        // Badges
        var badges = card.querySelectorAll('.node-badge');
        var bx = left + 10;
        var by = top + 175;
        badges.forEach(function(badge) {
          var bw = badge.textContent.length * 6 + 12;
          var bg = badge.classList.contains('badge-choice') ? '#1D70B8' :
                   badge.classList.contains('badge-end') ? '#00703C' : '#f3f2f1';
          var fg = (bg === '#f3f2f1') ? '#505a5f' : '#fff';

          var br = document.createElementNS(svgNs, 'rect');
          br.setAttribute('x', bx);
          br.setAttribute('y', by);
          br.setAttribute('width', bw);
          br.setAttribute('height', 16);
          br.setAttribute('rx', 3);
          br.setAttribute('fill', bg);
          svg.appendChild(br);

          var bt = document.createElementNS(svgNs, 'text');
          bt.setAttribute('x', bx + 6);
          bt.setAttribute('y', by + 12);
          bt.setAttribute('fill', fg);
          bt.setAttribute('font-size', '10');
          bt.setAttribute('font-weight', '700');
          bt.textContent = badge.textContent;
          svg.appendChild(bt);

          bx += bw + 4;
        });
      });

      // Render edge labels
      container.querySelectorAll('.edge-label').forEach(function(lbl) {
        var lx = parseInt(lbl.style.left);
        var ly = parseInt(lbl.style.top);
        var lw = lbl.offsetWidth;
        var lh = lbl.offsetHeight;

        // Centre on the midpoint (matches CSS transform: translate(-50%, -50%))
        var rx = lx - lw / 2 - 2;
        var ry = ly - lh / 2 - 2;

        var bg = document.createElementNS(svgNs, 'rect');
        bg.setAttribute('x', rx);
        bg.setAttribute('y', ry);
        bg.setAttribute('width', lw + 4);
        bg.setAttribute('height', lh + 4);
        bg.setAttribute('rx', 3);
        bg.setAttribute('fill', 'rgba(255,255,255,0.92)');
        bg.setAttribute('stroke', '#e0e0e0');
        bg.setAttribute('stroke-width', '1');
        svg.appendChild(bg);

        // Wrap text into lines
        var text = lbl.textContent.trim();
        var lines = [];
        var words = text.split(/\s+/);
        var line = '';
        words.forEach(function(word) {
          var test = line ? line + ' ' + word : word;
          if (test.length > 18 && line) { lines.push(line); line = word; }
          else { line = test; }
        });
        if (line) lines.push(line);

        lines.forEach(function(ln, i) {
          var lt = document.createElementNS(svgNs, 'text');
          lt.setAttribute('x', lx);
          lt.setAttribute('y', ry + 12 + i * 13);
          lt.setAttribute('text-anchor', 'middle');
          lt.setAttribute('fill', '#505a5f');
          lt.setAttribute('font-size', '10');
          lt.textContent = ln;
          svg.appendChild(lt);
        });
      });

      // Serialize and download
      var serializer = new XMLSerializer();
      var svgStr = serializer.serializeToString(svg);
      var blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'journey-map.svg';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    // ── Tabs / Lightbox ──
    function showTab(name) {
      document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
      document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
      document.getElementById(name).classList.add('active');
      event.target.classList.add('active');
    }
    function openLightbox(src) {
      document.getElementById('lightbox-img').src = src;
      document.getElementById('lightbox').classList.add('active');
    }
    function closeLightbox() {
      document.getElementById('lightbox').classList.remove('active');
    }

    // ── Init ──
    document.addEventListener('DOMContentLoaded', function() {
      renderDiagram();
      setTimeout(zoomFit, 200);
    });
  </` + `script>
</body>
</html>`;
}

function escapeHtml(text) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

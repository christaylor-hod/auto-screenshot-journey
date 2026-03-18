import ExcelJS from 'exceljs';
import path from 'path';

/**
 * Export crawl data to a well-formatted XLSX spreadsheet
 */
export async function exportToXlsx(crawlData, outputDir) {
  const { pages, edges, paths } = crawlData;
  const outputPath = path.join(outputDir, 'journey-map.xlsx');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Form Journey Mapper';
  workbook.created = new Date();

  // ═══════════════════════════════════════
  // Sheet 1: Pages
  // ═══════════════════════════════════════
  const pagesSheet = workbook.addWorksheet('Pages', {
    properties: { tabColor: { argb: '1D70B8' } }
  });

  pagesSheet.columns = [
    { header: 'Page ID', key: 'id', width: 25 },
    { header: 'Page Name', key: 'pageName', width: 50 },
    { header: 'Depth', key: 'depth', width: 8 },
    { header: 'URL', key: 'url', width: 60 },
    { header: 'Has Form', key: 'hasForm', width: 12 },
    { header: 'Field Count', key: 'fieldCount', width: 14 },
    { header: 'Choice Points', key: 'choicePoints', width: 16 },
    { header: 'Is End Page', key: 'isEndPage', width: 13 },
    { header: 'Links To', key: 'linksTo', width: 50 }
  ];

  // Style header row
  styleHeaderRow(pagesSheet, '1D70B8');

  // Build parent→child depth map using edges
  // Start page (no incoming edge) is depth 0, its children are depth 1, etc.
  const pageUrls = [...pages.keys()];
  const childrenOf = new Map(); // parentUrl → [childUrl, ...]
  const parentOf = new Map();   // childUrl → parentUrl
  const edgeLabelsMap = new Map(); // "from→to" → label

  for (const edge of edges) {
    const key = `${edge.from}→${edge.to}`;
    if (!edgeLabelsMap.has(key)) edgeLabelsMap.set(key, edge.label);
    if (!childrenOf.has(edge.from)) childrenOf.set(edge.from, []);
    const children = childrenOf.get(edge.from);
    if (!children.includes(edge.to)) children.push(edge.to);
    // Only set first parent (some pages may have multiple parents)
    if (!parentOf.has(edge.to)) parentOf.set(edge.to, edge.from);
  }

  // Calculate depths via BFS from root pages (pages with no parent)
  const depthMap = new Map();
  const roots = pageUrls.filter(u => !parentOf.has(u));
  if (roots.length === 0 && pageUrls.length > 0) roots.push(pageUrls[0]);

  const queue = roots.map(r => ({ url: r, depth: 0 }));
  const visited = new Set();
  while (queue.length > 0) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    depthMap.set(url, depth);
    const children = childrenOf.get(url) || [];
    for (const child of children) {
      if (!visited.has(child)) queue.push({ url: child, depth: depth + 1 });
    }
  }
  // Any unvisited pages get depth 0
  for (const url of pageUrls) {
    if (!depthMap.has(url)) depthMap.set(url, 0);
  }

  // Sort pages by depth-first tree order for clear hierarchy
  const orderedPages = [];
  const addedToOrder = new Set();
  function addPageTree(url) {
    if (addedToOrder.has(url) || !pages.has(url)) return;
    addedToOrder.add(url);
    orderedPages.push(url);
    const children = childrenOf.get(url) || [];
    for (const child of children) addPageTree(child);
  }
  for (const root of roots) addPageTree(root);
  // Add any remaining pages not reachable from roots
  for (const url of pageUrls) {
    if (!addedToOrder.has(url)) { addedToOrder.add(url); orderedPages.push(url); }
  }

  for (const pageUrl of orderedPages) {
    const pageData = pages.get(pageUrl);
    if (!pageData) continue;

    const depth = depthMap.get(pageUrl) || 0;
    const indent = '  '.repeat(depth); // Two-space indent per level
    const outgoingEdges = edges.filter(e => e.from === pageUrl);
    const linksTo = [...new Set(outgoingEdges.map(e => {
      const targetPage = pages.get(e.to);
      return targetPage ? `${targetPage.pageName} (${e.label})` : `${e.to} (${e.label})`;
    }))].join('\n');

    const row = pagesSheet.addRow({
      id: pageData.id,
      pageName: `${indent}${pageData.pageName}`,
      depth: depth,
      url: pageData.url,
      hasForm: pageData.fields.length > 0 ? 'Yes' : 'No',
      fieldCount: pageData.fields.length,
      choicePoints: pageData.choicePoints.length,
      isEndPage: pageData.isEndPage ? 'Yes' : 'No',
      linksTo: linksTo
    });

    // Indent styling: lighter background for deeper pages
    if (depth > 0) {
      const indentLevel = Math.min(depth, 5);
      const grey = 245 - (indentLevel * 8); // subtly darker at each level
      row.getCell('pageName').font = { indent: depth };
      row.getCell('pageName').alignment = { indent: depth, vertical: 'top' };
    }
  }

  // Auto-filter
  pagesSheet.autoFilter = {
    from: 'A1',
    to: `I${pagesSheet.rowCount}`
  };

  // ═══════════════════════════════════════
  // Sheet 2: Form Fields
  // ═══════════════════════════════════════
  const fieldsSheet = workbook.addWorksheet('Form Fields', {
    properties: { tabColor: { argb: '00703C' } }
  });

  fieldsSheet.columns = [
    { header: 'Page Name', key: 'pageName', width: 35 },
    { header: 'Page URL', key: 'pageUrl', width: 50 },
    { header: 'Field Label', key: 'label', width: 35 },
    { header: 'Field Name', key: 'name', width: 30 },
    { header: 'Field ID', key: 'id', width: 30 },
    { header: 'Field Type', key: 'type', width: 15 },
    { header: 'Required', key: 'required', width: 12 },
    { header: 'Options', key: 'options', width: 50 },
    { header: 'Hint', key: 'hint', width: 40 },
    { header: 'Pattern', key: 'pattern', width: 20 },
    { header: 'Max Length', key: 'maxLength', width: 12 },
    { header: 'Autocomplete', key: 'autocomplete', width: 20 },
    { header: 'Is Choice Point', key: 'isChoicePoint', width: 16 }
  ];

  styleHeaderRow(fieldsSheet, '00703C');

  for (const [pageUrl, pageData] of pages) {
    for (const field of pageData.fields) {
      const optionsStr = field.options
        ? field.options.map(o => `${o.value}: ${o.text}`).join('\n')
        : '';

      fieldsSheet.addRow({
        pageName: pageData.pageName,
        pageUrl: pageData.url,
        label: field.label,
        name: field.name,
        id: field.id,
        type: field.type,
        required: field.required ? 'Yes' : 'No',
        options: optionsStr,
        hint: field.hint || '',
        pattern: field.pattern || '',
        maxLength: field.maxLength || '',
        autocomplete: field.autocomplete || '',
        isChoicePoint: field.isChoicePoint ? 'Yes' : 'No'
      });
    }
  }

  fieldsSheet.autoFilter = {
    from: 'A1',
    to: `M${fieldsSheet.rowCount}`
  };

  // ═══════════════════════════════════════
  // Sheet 3: Journey Paths
  // ═══════════════════════════════════════
  const pathsSheet = workbook.addWorksheet('Journey Paths', {
    properties: { tabColor: { argb: 'D4351C' } }
  });

  pathsSheet.columns = [
    { header: 'Path ID', key: 'pathId', width: 15 },
    { header: 'Step', key: 'step', width: 8 },
    { header: 'Page Name', key: 'pageName', width: 40 },
    { header: 'URL', key: 'url', width: 60 },
    { header: 'Choices Made', key: 'choices', width: 50 }
  ];

  styleHeaderRow(pathsSheet, 'D4351C');

  for (const p of paths) {
    p.steps.forEach((step, i) => {
      const choicesStr = Object.entries(step.choices || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');

      pathsSheet.addRow({
        pathId: p.id,
        step: i + 1,
        pageName: step.pageName,
        url: step.url,
        choices: choicesStr
      });
    });

    // Add empty row between paths
    pathsSheet.addRow({});
  }

  // ═══════════════════════════════════════
  // Sheet 4: Edges / Connections
  // ═══════════════════════════════════════
  const edgesSheet = workbook.addWorksheet('Connections', {
    properties: { tabColor: { argb: 'F47738' } }
  });

  edgesSheet.columns = [
    { header: 'From Page', key: 'from', width: 40 },
    { header: 'To Page', key: 'to', width: 40 },
    { header: 'From URL', key: 'fromUrl', width: 50 },
    { header: 'To URL', key: 'toUrl', width: 50 },
    { header: 'Trigger / Label', key: 'label', width: 40 }
  ];

  styleHeaderRow(edgesSheet, 'F47738');

  // Deduplicate edges
  const edgeSet = new Set();
  for (const edge of edges) {
    const key = `${edge.from}→${edge.to}→${edge.label}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);

    const fromPage = pages.get(edge.from);
    const toPage = pages.get(edge.to);

    edgesSheet.addRow({
      from: fromPage?.pageName || edge.from,
      to: toPage?.pageName || edge.to,
      fromUrl: edge.from,
      toUrl: edge.to,
      label: edge.label
    });
  }

  // Save
  await workbook.xlsx.writeFile(outputPath);
  console.log(`📊 Spreadsheet saved: ${outputPath}`);
  return outputPath;
}

/**
 * Style a header row with GOV.UK-ish styling
 */
function styleHeaderRow(sheet, colorHex) {
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFF' }, size: 11, name: 'Arial' };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: colorHex }
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
  headerRow.height = 24;

  // Freeze header row
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

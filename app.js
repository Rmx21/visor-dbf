"use strict";

const dbfInput = document.getElementById("dbf-input");
const companionInput = document.getElementById("companion-input");
const textDecoders = new Map();
const dropzone = document.getElementById("dropzone");
const uploadCard = document.querySelector(".upload-card");
const results = document.getElementById("results");
const errorMessage = document.getElementById("error-message");
const encodingSelect = document.getElementById("encoding-select");
const companions = new Map();
const pendingCompanionFiles = new Map();
let loadedDbf = null;
let pendingDbfFile = null;
let selectionVersion = 0;
let isAnalyzing = false;
let recordSearchMatches = null;
let recordPage = 0;
let recordSearchToken = 0;
let recordSearchTimer = null;
let searchMode = "and";
let appliedSearchTerms = [];
const recordsPerPage = 250;
const searchChunkSize = 16384;
const maxMemoCacheEntries = 1024;
const maxMemoCacheCharacters = 4 * 1024 * 1024;
const maxCachedMemoCharacters = 64 * 1024;

const foxProVersions = new Set([0x30, 0x31, 0x32, 0xf5]);
const memoTypes = new Set(["M", "G", "P", "W"]);

function setSearchLoading(loading, message = "") {
  document.getElementById("search-loading").hidden = !loading;
  document.getElementById("search-loading-text").textContent = message;
}

function setPreviewExpanded(expanded) {
  document.body.classList.toggle("preview-expanded", expanded);
  const button = document.getElementById("expand-preview-button");
  button.textContent = expanded ? "Contraer" : "Expandir";
  button.setAttribute("aria-expanded", String(expanded));
}

function decode(bytes, encoding = encodingSelect.value) {
  try {
    let decoder = textDecoders.get(encoding);
    if (!decoder) {
      decoder = new TextDecoder(encoding);
      textDecoders.set(encoding, decoder);
    }
    return decoder.decode(bytes);
  } catch (error) {
    throw new Error(`El navegador no admite la codificación ${encoding}.`);
  }
}

function readAscii(bytes) {
  return String.fromCharCode(...bytes).replace(/\0.*$/s, "").trim();
}

function readUint32LE(view, offset) {
  return view.getUint32(offset, true);
}

function readMemoPointers(raw, encoding) {
  const pointers = [];
  if (raw.length >= 4) {
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    pointers.push(view.getUint32(0, true), view.getUint32(0, false));
  }
  const text = decode(raw, encoding).replace(/\0+$/g, "").trim();
  if (/^\d+$/.test(text)) pointers.push(Number(text));
  return [...new Set(pointers.filter((pointer) => pointer > 0))];
}

function readMemoPointer(raw, encoding) {
  return readMemoPointers(raw, encoding)[0] || 0;
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function parseDbf(buffer, name) {
  if (buffer.byteLength < 33) throw new Error("El archivo es demasiado pequeño para ser un DBF válido.");
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const version = bytes[0];
  const recordCount = readUint32LE(view, 4);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);
  const tableFlags = bytes[28] || 0;
  if (headerLength < 33 || headerLength > buffer.byteLength) {
    throw new Error("La longitud del encabezado DBF es inválida o está incompleta.");
  }
  if (recordLength < 1) throw new Error("La longitud de registro indicada en el encabezado no es válida.");

  const fields = [];
  let fieldRecordOffset = 1;
  for (let offset = 32; offset < headerLength && bytes[offset] !== 0x0d; offset += 32) {
    if (offset + 32 > headerLength) throw new Error("El descriptor de campos está incompleto.");
    const descriptor = bytes.subarray(offset, offset + 32);
    const fieldName = readAscii(descriptor.subarray(0, 11));
    const type = String.fromCharCode(descriptor[11]);
    if (!fieldName) continue;
    fields.push({
      name: fieldName,
      type,
      length: descriptor[16],
      decimals: descriptor[17],
      recordOffset: fieldRecordOffset,
    });
    fieldRecordOffset += descriptor[16];
  }
  if (!fields.length) throw new Error("No se encontraron campos en el encabezado DBF.");
  const fieldsLength = fields.reduce((total, field) => total + field.length, 1);
  if (fieldsLength > recordLength) throw new Error("Los campos no caben en la longitud de registro indicada.");

  return {
    name,
    bytes,
    version,
    recordCount,
    headerLength,
    recordLength,
    tableFlags,
    fields,
    actualRecords: Math.min(recordCount, Math.floor((buffer.byteLength - headerLength) / recordLength)),
    fileSize: buffer.byteLength,
  };
}

function versionLabel(version) {
  const labels = {
    0x02: "FoxBASE",
    0x03: "dBASE III",
    0x04: "dBASE IV",
    0x30: "Visual FoxPro",
    0x31: "Visual FoxPro (autoincremento)",
    0x32: "Visual FoxPro (varchar/varbinary)",
    0x83: "dBASE III con memo",
    0x8b: "dBASE IV con memo",
    0xf5: "FoxPro 2.x con memo",
  };
  return labels[version] || `Formato DBF (0x${version.toString(16).padStart(2, "0").toUpperCase()})`;
}

function parseFptMemo(pointer, encoding = encodingSelect.value, file = companions.get("fpt")) {
  if (!file || !pointer) return null;
  const cacheKey = `${encoding}:${pointer}`;
  if (file.memoCache.has(cacheKey)) return file.memoCache.get(cacheKey);
  const { bytes, view } = file;
  if (bytes.length < 8) return null;
  const blockSize = view.getUint16(6, false);
  if (!blockSize) return null;
  const offset = pointer * blockSize;
  if (offset + 8 > bytes.length) return null;
  const type = view.getUint32(offset, false);
  const length = view.getUint32(offset + 4, false);
  if (length > bytes.length - offset - 8) return null;
  const memo = bytes.subarray(offset + 8, offset + 8 + length);
  const value = type === 1
    ? decode(memo, encoding).replace(/\0+$/g, "")
    : type === 0
      ? "[memo vacío]"
      : `[memo binario, tipo ${type}, ${length} bytes]`;
  if (value.length <= maxCachedMemoCharacters) {
    if (file.memoCache.size >= maxMemoCacheEntries || file.memoCacheCharacters + value.length > maxMemoCacheCharacters) {
      file.memoCache.clear();
      file.memoCacheCharacters = 0;
    }
    file.memoCache.set(cacheKey, value);
    file.memoCacheCharacters += value.length;
  }
  return value;
}

function readFieldValue(record, field, encoding, fptFile = companions.get("fpt")) {
  const start = field.recordOffset;
  const raw = record.subarray(start, start + field.length);
  if (memoTypes.has(field.type)) {
    const pointers = readMemoPointers(raw, encoding);
    if (!pointers.length) return "";
    if (!fptFile) return `Bloque memo ${pointers[0]}`;
    for (const pointer of pointers) {
      const memo = parseFptMemo(pointer, encoding, fptFile);
      if (memo !== null) return memo;
    }
    return "[referencia FPT no válida]";
  }

  const value = decode(raw, encoding).trim();
  if (!value) return "";
  if (field.type === "D" && /^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (field.type === "L") {
    const logical = value.toUpperCase();
    if (["Y", "T"].includes(logical)) return "Sí";
    if (["N", "F"].includes(logical)) return "No";
  }
  return value;
}

function appendSearchHighlight(cell, value, terms) {
  if (!terms.length) {
    cell.textContent = value;
    return;
  }
  const matcher = new RegExp(terms
    .slice()
    .sort((left, right) => right.length - left.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"), "gi");
  let lastIndex = 0;
  let match;
  while ((match = matcher.exec(value)) !== null) {
    cell.append(document.createTextNode(value.slice(lastIndex, match.index)));
    const highlighted = document.createElement("mark");
    highlighted.className = "search-match";
    highlighted.textContent = match[0];
    cell.append(highlighted);
    lastIndex = matcher.lastIndex;
  }
  cell.append(document.createTextNode(value.slice(lastIndex)));
}

function csvCell(value, numeric = false) {
  let text = String(value ?? "");
  if (!numeric && /^[\u0000-\u0020]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCsv(filename, rows) {
  const blob = new Blob(["\uFEFF", rows.join("\r\n"), "\r\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvFilename(suffix) {
  const baseName = loadedDbf.name.replace(/\.[^.]+$/, "") || "datos";
  return `${suffix}_${baseName}.csv`;
}

function exportFieldsCsv() {
  const rows = [
    ["Nombre", "Tipo", "Longitud", "Decimales"].map((value) => csvCell(value)).join(","),
    ...loadedDbf.fields.map((field) => [
      csvCell(field.name),
      csvCell(field.type),
      csvCell(field.length, true),
      csvCell(field.decimals, true),
    ].join(",")),
  ];
  downloadCsv(csvFilename("campos"), rows);
}

async function exportRecordsCsv(button) {
  const dbf = loadedDbf;
  const matches = recordSearchMatches;
  const encoding = encodingSelect.value;
  const fptFile = companions.get("fpt");
  const numericTypes = new Set(["N", "F", "B", "I", "Y"]);
  const rows = [dbf.fields.map((field) => csvCell(field.name)).join(",")];
  const batchSize = 500;
  const recordCount = matches === null ? dbf.actualRecords : matches.count;
  button.disabled = true;
  button.title = "Preparando CSV…";
  button.setAttribute("aria-label", "Preparando CSV de registros");
  try {
    for (let batchStart = 0; batchStart < recordCount; batchStart += batchSize) {
      const batchEnd = Math.min(batchStart + batchSize, recordCount);
      for (let displayIndex = batchStart; displayIndex < batchEnd; displayIndex += 1) {
        const index = matches === null
          ? displayIndex
          : matches.chunks[Math.floor(displayIndex / searchChunkSize)][displayIndex % searchChunkSize];
        const offset = dbf.headerLength + index * dbf.recordLength;
        const record = dbf.bytes.subarray(offset, offset + dbf.recordLength);
        if (record.length < dbf.recordLength) break;
        rows.push(dbf.fields.map((field) => csvCell(
          readFieldValue(record, field, encoding, fptFile),
          numericTypes.has(field.type),
        )).join(","));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    downloadCsv(csvFilename("registros"), rows);
  } catch (error) {
    showError(`No se pudo exportar el CSV de registros: ${error.message}`);
  } finally {
    button.disabled = false;
    button.title = "Descargar registros como CSV";
    button.setAttribute("aria-label", "Descargar registros como CSV");
  }
}

function companionAssessment() {
  const dbf = loadedDbf;
  const memoFields = dbf.fields.filter((field) => memoTypes.has(field.type));
  const isFoxPro = foxProVersions.has(dbf.version);
  const hasCdxFlag = isFoxPro && Boolean(dbf.tableFlags & 0x01);
  const fptExpected = isFoxPro && memoFields.length > 0;
  const dbtExpected = !isFoxPro && memoFields.length > 0;
  const cdx = companions.get("cdx");
  const fpt = companions.get("fpt");
  const dbt = companions.get("dbt");
  const memoReferences = memoFields.reduce((total, field) => {
    const fieldIndex = dbf.fields.indexOf(field);
    let references = 0;
    for (let index = 0; index < dbf.actualRecords; index += 1) {
      const offset = dbf.headerLength + index * dbf.recordLength;
      const record = dbf.bytes.subarray(offset, offset + dbf.recordLength);
      if (readMemoPointer(record.subarray(field.recordOffset, field.recordOffset + field.length), encodingSelect.value) > 0) references += 1;
    }
    return total + references;
  }, 0);
  const result = [];

  let cdxDetail;
  let cdxStatus;
  let cdxTone;
  if (hasCdxFlag) {
    cdxDetail = cdx
      ? `El encabezado marca un índice estructural y se seleccionó ${cdx.name}. Es un auxiliar del índice, no se usa para decodificar los registros de la tabla.`
      : "El encabezado marca que hay un índice estructural asociado. Sí se necesita para conservar o utilizar ese índice; no hace falta para leer los registros de la tabla.";
    cdxStatus = cdx ? "Asociado · cargado" : "Asociado · no cargado";
    cdxTone = cdx ? "" : "warning";
  } else {
    cdxDetail = cdx
      ? `Se seleccionó ${cdx.name}, pero el DBF no marca un CDX estructural. Puede ser un índice no estructural; este encabezado no permite confirmar si la aplicación lo utiliza.`
      : "El encabezado no indica un CDX estructural. Ningún índice CDX es necesario para mostrar los campos y registros; la aplicación original podría usar índices no estructurales.";
    cdxStatus = cdx ? "Opcional · cargado" : "No indicado";
    cdxTone = "neutral";
  }
  result.push({
    extension: "CDX",
    answer: hasCdxFlag ? "sí" : "no",
    detail: cdxDetail,
    status: cdxStatus,
    tone: cdxTone,
    iconTone: hasCdxFlag && !cdx ? "warning" : "neutral",
  });

  if (fptExpected) {
    const detail = memoReferences === 0
      ? `${memoFields.length} campo(s) memo/gráfico detectado(s), pero no se encontraron referencias memo en los registros presentes.`
      : fpt
        ? `${memoFields.length} campo(s) memo/gráfico y ${memoReferences} referencia(s) detectada(s). ${fpt.name} está cargado; se intentarán leer sus bloques memo.`
        : `${memoFields.length} campo(s) memo/gráfico (${memoFields.map((field) => field.name).join(", ")}) y ${memoReferences} referencia(s) detectada(s). El formato FoxPro normalmente guarda esos valores en un FPT; sin él, los contenidos no están disponibles.`;
    result.push({
      extension: "FPT",
      answer: memoReferences > 0 ? "sí" : "no",
      detail,
      status: memoReferences === 0 ? "Sin referencias detectadas" : fpt ? "Necesario para memo · cargado" : "Necesario para memo",
      tone: memoReferences === 0 || fpt ? "" : "warning",
      iconTone: memoReferences === 0 || fpt ? "" : "warning",
    });
  } else if (dbtExpected) {
    result.push({
      extension: "FPT",
      answer: "no",
      detail: memoReferences === 0
        ? `Se detectaron campos memo, pero no referencias activas en los registros presentes. ${versionLabel(dbf.version)} suele usar DBT, no FPT.`
        : `Se detectaron campos memo (${memoFields.map((field) => field.name).join(", ")}) y ${memoReferences} referencia(s). ${versionLabel(dbf.version)} suele usar DBT, no FPT.${dbt ? ` Se seleccionó ${dbt.name}, que puede contener esos datos.` : " Si necesitas leer los memos, busca el archivo .dbt correspondiente."}`,
      status: memoReferences === 0 ? "Sin referencias detectadas" : "Probablemente usa DBT",
      tone: memoReferences === 0 ? "neutral" : "warning",
      iconTone: memoReferences === 0 ? "neutral" : "warning",
    });
  } else {
    result.push({
      extension: "FPT",
      answer: "no",
      detail: "No se detectaron campos memo/gráfico en el DBF; no hay indicios de que necesite un archivo FPT.",
      status: "No indicado",
      tone: "neutral",
      iconTone: "neutral",
    });
  }
  return result;
}

function renderSummary() {
  const cards = [
    ["Registros", loadedDbf.recordCount.toLocaleString("es-MX"), loadedDbf.actualRecords < loadedDbf.recordCount ? `${loadedDbf.actualRecords.toLocaleString("es-MX")} disponibles` : "en el archivo"],
    ["Campos", loadedDbf.fields.length, "columnas detectadas"],
    ["Formato", versionLabel(loadedDbf.version), `Versión 0x${loadedDbf.version.toString(16).padStart(2, "0").toUpperCase()}`],
    ["Tamaño", formatBytes(loadedDbf.fileSize), "archivo DBF"],
  ];
  document.getElementById("summary-cards").replaceChildren(...cards.map(([label, value, hint]) => {
    const card = document.createElement("div");
    card.className = "summary-card";
    card.innerHTML = `<span class="summary-label">${label}</span><strong class="summary-value"></strong><span class="summary-hint">${hint}</span>`;
    card.querySelector(".summary-value").textContent = value;
    return card;
  }));
}

function renderDependencies() {
  const list = document.getElementById("dependency-list");
  list.replaceChildren(...companionAssessment().map((item) => {
    const row = document.createElement("div");
    row.className = "dependency-item";
    const icon = document.createElement("span");
    icon.className = `dependency-icon ${item.iconTone}`;
    icon.textContent = item.extension;
    const copy = document.createElement("div");
    const name = document.createElement("div");
    name.className = "dependency-name";
    name.textContent = `Archivo .${item.extension.toLowerCase()}`;
    const answer = document.createElement("span");
    answer.className = `dependency-answer ${item.answer === "sí" ? "yes" : "no"}`;
    answer.textContent = item.answer;
    answer.setAttribute("aria-label", `Necesario: ${item.answer}`);
    const detail = document.createElement("div");
    detail.className = "dependency-detail";
    detail.textContent = item.detail;
    copy.append(name, answer, detail);
    const status = document.createElement("span");
    status.className = `dependency-status ${item.tone}`;
    status.textContent = item.status;
    row.append(icon, copy, status);
    return row;
  }));
}

function renderFields() {
  const body = document.getElementById("fields-body");
  body.replaceChildren(...loadedDbf.fields.map((field) => {
    const fptAffected = foxProVersions.has(loadedDbf.version) && memoTypes.has(field.type);
    const row = document.createElement("tr");
    if (fptAffected) row.className = "fpt-affected";
    row.innerHTML = `<td></td><td><code></code></td><td class="numeric"></td><td class="numeric"></td>`;
    row.children[0].textContent = field.name;
    row.children[1].firstElementChild.textContent = field.type;
    row.children[2].textContent = field.length;
    row.children[3].textContent = field.decimals;
    return row;
  }));
}

function renderRecords() {
  const header = document.getElementById("records-head");
  const body = document.getElementById("records-body");
  const fields = loadedDbf.fields;
  const recordCount = recordSearchMatches === null ? loadedDbf.actualRecords : recordSearchMatches.count;
  const pageCount = Math.max(1, Math.ceil(recordCount / recordsPerPage));
  recordPage = Math.min(recordPage, pageCount - 1);
  const start = recordPage * recordsPerPage;
  const end = Math.min(start + recordsPerPage, recordCount);
  header.replaceChildren();
  const headerRow = document.createElement("tr");
  const matchedFieldIndices = recordSearchMatches?.fieldIndices;
  for (const [fieldIndex, field] of fields.entries()) {
    const th = document.createElement("th");
    if (foxProVersions.has(loadedDbf.version) && memoTypes.has(field.type)) th.className = "fpt-affected";
    if (matchedFieldIndices?.has(fieldIndex) || appliedSearchTerms.some((term) => field.name.toLocaleLowerCase().includes(term))) {
      const highlighted = document.createElement("mark");
      highlighted.className = "search-match";
      appendSearchHighlight(th, field.name, appliedSearchTerms);
    } else {
      th.textContent = field.name;
    }
    headerRow.append(th);
  }
  header.append(headerRow);

  const rows = [];
  for (let displayIndex = start; displayIndex < end; displayIndex += 1) {
    const index = recordSearchMatches === null
      ? displayIndex
      : recordSearchMatches.chunks[Math.floor(displayIndex / searchChunkSize)][displayIndex % searchChunkSize];
    const offset = loadedDbf.headerLength + index * loadedDbf.recordLength;
    const record = loadedDbf.bytes.subarray(offset, offset + loadedDbf.recordLength);
    if (record.length < loadedDbf.recordLength) break;
    const deleted = record[0] === 0x2a;
    const tr = document.createElement("tr");
    if (deleted) tr.className = "record-deleted";
    fields.forEach((field, fieldIndex) => {
      const td = document.createElement("td");
      if (foxProVersions.has(loadedDbf.version) && memoTypes.has(field.type)) td.className = "fpt-affected";
      appendSearchHighlight(td, readFieldValue(record, field, encodingSelect.value), appliedSearchTerms);
      if (fieldIndex === 0 && deleted) {
        const badge = document.createElement("span");
        badge.className = "deleted-badge";
        badge.textContent = "eliminado";
        td.append(badge);
      }
      tr.append(td);
    });
    rows.push(tr);
  }
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.className = "empty-state";
    cell.colSpan = fields.length;
    cell.textContent = recordSearchMatches !== null ? "No se encontraron coincidencias." : "El archivo no contiene registros para mostrar.";
    row.append(cell);
    rows.push(row);
  }
  body.replaceChildren(...rows);
  document.getElementById("record-count").textContent = `${recordCount.toLocaleString("es-MX")} registros`;
  document.getElementById("page-status").textContent = `${recordCount === 0 ? 0 : start + 1}–${end} de ${recordCount.toLocaleString("es-MX")}`;
  document.getElementById("previous-page").disabled = recordPage === 0;
  document.getElementById("next-page").disabled = recordPage >= pageCount - 1;
  document.getElementById("records-note").textContent = loadedDbf.actualRecords < loadedDbf.recordCount
    ? `El encabezado indica ${loadedDbf.recordCount.toLocaleString("es-MX")} registros, pero solo caben ${loadedDbf.actualRecords.toLocaleString("es-MX")} en el archivo. Se muestran hasta ${recordsPerPage} por página.`
    : `Se muestran hasta ${recordsPerPage} registros por página. Los registros marcados como eliminados siguen visibles.`;
}

async function searchRecords(query) {
  const token = ++recordSearchToken;
  const terms = [...new Set(query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean))];
  recordPage = 0;
  document.getElementById("search-status").textContent = terms.length ? "Buscando…" : "";
  if (!terms.length) {
    recordSearchMatches = null;
    appliedSearchTerms = [];
    setSearchLoading(false);
    renderRecords();
    return;
  }
  setSearchLoading(true, "Buscando en los registros…");

  const matchChunks = [];
  const matchedFieldIndices = new Set();
  let matchChunk = new Uint32Array(searchChunkSize);
  let matchChunkLength = 0;
  let matchCount = 0;
  const batchSize = 500;
  try {
    for (let batchStart = 0; batchStart < loadedDbf.actualRecords; batchStart += batchSize) {
      if (token !== recordSearchToken) return;
      const batchEnd = Math.min(batchStart + batchSize, loadedDbf.actualRecords);
      for (let index = batchStart; index < batchEnd; index += 1) {
        const offset = loadedDbf.headerLength + index * loadedDbf.recordLength;
        const record = loadedDbf.bytes.subarray(offset, offset + loadedDbf.recordLength);
        const matchedTerms = new Set();
        const rowFieldIndices = [];
        for (let fieldIndex = 0; fieldIndex < loadedDbf.fields.length; fieldIndex += 1) {
          const value = readFieldValue(record, loadedDbf.fields[fieldIndex], encodingSelect.value).toLocaleLowerCase();
          const fieldMatches = terms.filter((term) => value.includes(term));
          if (fieldMatches.length) {
            rowFieldIndices.push(fieldIndex);
            fieldMatches.forEach((term) => matchedTerms.add(term));
          }
        }
        const matchedRow = searchMode === "and"
          ? matchedTerms.size === terms.length
          : matchedTerms.size > 0;
        if (matchedRow) {
          rowFieldIndices.forEach((fieldIndex) => matchedFieldIndices.add(fieldIndex));
          matchChunk[matchChunkLength] = index;
          matchChunkLength += 1;
          matchCount += 1;
          if (matchChunkLength === searchChunkSize) {
            matchChunks.push(matchChunk);
            matchChunk = new Uint32Array(searchChunkSize);
            matchChunkLength = 0;
          }
        }
      }
      const progress = `Buscando… ${batchEnd.toLocaleString("es-MX")} de ${loadedDbf.actualRecords.toLocaleString("es-MX")}`;
      document.getElementById("search-status").textContent = progress;
      setSearchLoading(true, progress);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (token !== recordSearchToken) return;
    if (matchChunkLength) matchChunks.push(matchChunk.subarray(0, matchChunkLength));
    recordSearchMatches = { chunks: matchChunks, count: matchCount, fieldIndices: matchedFieldIndices };
    appliedSearchTerms = terms;
    document.getElementById("search-status").textContent = `${matchCount.toLocaleString("es-MX")} coincidencias`;
    setSearchLoading(false);
    renderRecords();
  } catch (error) {
    if (token === recordSearchToken) {
      document.getElementById("search-status").textContent = "";
      setSearchLoading(false);
      showError(`No se pudo buscar en los registros: ${error.message}`);
    }
  }
}

function render() {
  setPreviewExpanded(false);
  document.getElementById("file-title").textContent = loadedDbf.name;
  document.getElementById("file-subtitle").textContent = `${versionLabel(loadedDbf.version)} · ${loadedDbf.fields.length} campos`;
  renderSummary();
  renderDependencies();
  renderFields();
  recordSearchToken += 1;
  recordSearchMatches = null;
  recordPage = 0;
  appliedSearchTerms = [];
  document.getElementById("record-search").value = "";
  document.getElementById("search-status").textContent = "";
  setSearchLoading(false);
  renderRecords();
  document.querySelector(".results-grid").dataset.mobileView = "records";
  document.querySelectorAll(".results-view-tab").forEach((tab) => {
    const active = tab.dataset.view === "records";
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });
  uploadCard.hidden = true;
  document.body.classList.add("results-active");
  results.hidden = false;
  errorMessage.hidden = true;
}

function updateSelection() {
  const summary = document.getElementById("selection-summary");
  const analyzeButton = document.getElementById("analyze-button");
  const selectedNames = [];
  if (pendingDbfFile) selectedNames.push(pendingDbfFile.name);
  for (const file of pendingCompanionFiles.values()) selectedNames.push(file.name);
  summary.textContent = selectedNames.length
    ? `Seleccionados: ${selectedNames.join(", ")}`
    : "Selecciona un DBF para habilitar el análisis.";
  analyzeButton.disabled = !pendingDbfFile || isAnalyzing;
}

function stageFilesChanged() {
  setPreviewExpanded(false);
  selectionVersion += 1;
  recordSearchToken += 1;
  clearTimeout(recordSearchTimer);
  results.hidden = true;
  setSearchLoading(false);
  uploadCard.hidden = false;
  document.body.classList.remove("results-active");
  errorMessage.hidden = true;
  updateSelection();
}

async function analyzeFiles() {
  if (!pendingDbfFile) {
    showError("Selecciona un archivo DBF antes de analizar.");
    return;
  }
  const version = selectionVersion;
  const dbfFile = pendingDbfFile;
  const companionFiles = new Map(pendingCompanionFiles);
  const analyzeButton = document.getElementById("analyze-button");
  isAnalyzing = true;
  analyzeButton.disabled = true;
  analyzeButton.textContent = "Analizando…";
  errorMessage.hidden = true;
  try {
    const [dbfBuffer, ...companionBuffers] = await Promise.all([
      dbfFile.arrayBuffer(),
      ...Array.from(companionFiles.values(), (file) => file.arrayBuffer()),
    ]);
    if (version !== selectionVersion) return;

    const parsedDbf = parseDbf(dbfBuffer, dbfFile.name);
    const parsedCompanions = new Map();
    Array.from(companionFiles.entries()).forEach(([extension, file], index) => {
      const buffer = companionBuffers[index];
      const companion = { name: file.name, buffer };
      if (extension === "fpt") {
        companion.bytes = new Uint8Array(buffer);
        companion.view = new DataView(buffer);
        companion.memoCache = new Map();
        companion.memoCacheCharacters = 0;
      }
      parsedCompanions.set(extension, companion);
    });
    loadedDbf = parsedDbf;
    companions.clear();
    for (const [extension, file] of parsedCompanions) companions.set(extension, file);
    render();
  } catch (error) {
    if (version === selectionVersion) showError(error.message);
  } finally {
    isAnalyzing = false;
    analyzeButton.textContent = "Analizar archivos";
    updateSelection();
  }
}

function stageCompanions(files) {
  const rejectedFiles = [];
  for (const file of files) {
    const extension = file.name.split(".").pop().toLowerCase();
    if (!["cdx", "fpt", "dbt"].includes(extension)) {
      rejectedFiles.push(file.name);
      continue;
    }
    pendingCompanionFiles.set(extension, file);
  }
  stageFilesChanged();
  if (rejectedFiles.length) {
    showError(`No se admiten estos archivos auxiliares: ${rejectedFiles.join(", ")}. Selecciona archivos CDX, FPT o DBT.`);
  }
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
}

dbfInput.addEventListener("change", () => {
  if (dbfInput.files[0]) {
    pendingDbfFile = dbfInput.files[0];
    stageFilesChanged();
  }
});
companionInput.addEventListener("change", () => {
  if (companionInput.files.length) stageCompanions(companionInput.files);
  companionInput.value = "";
});
encodingSelect.addEventListener("change", () => {
  if (loadedDbf) {
    const query = document.getElementById("record-search").value;
    if (query.trim()) searchRecords(query);
    else renderRecords();
  }
});
document.getElementById("record-search").addEventListener("input", () => {
  recordSearchToken += 1;
  clearTimeout(recordSearchTimer);
  const query = document.getElementById("record-search").value;
  if (!query.trim()) {
    document.getElementById("search-status").textContent = "";
    searchRecords("");
    return;
  }
  document.getElementById("search-status").textContent = "Preparando búsqueda…";
  setSearchLoading(true, "Preparando búsqueda…");
  recordSearchTimer = setTimeout(() => searchRecords(query), 250);
});
document.querySelectorAll(".search-mode-button").forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.mode;
    if (searchMode === mode) return;
    searchMode = mode;
    document.querySelectorAll(".search-mode-button").forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
    const input = document.getElementById("record-search");
    const query = input.value;
    recordSearchToken += 1;
    clearTimeout(recordSearchTimer);
    if (!query.trim()) return;
    document.getElementById("search-status").textContent = "Preparando búsqueda…";
    setSearchLoading(true, "Preparando búsqueda…");
    recordSearchTimer = setTimeout(() => searchRecords(query), 0);
  });
});
document.getElementById("previous-page").addEventListener("click", () => {
  if (recordPage > 0) {
    recordPage -= 1;
    renderRecords();
  }
});
document.getElementById("next-page").addEventListener("click", () => {
  const count = recordSearchMatches === null ? loadedDbf?.actualRecords || 0 : recordSearchMatches.count;
  if ((recordPage + 1) * recordsPerPage < count) {
    recordPage += 1;
    renderRecords();
  }
});
document.getElementById("expand-preview-button").addEventListener("click", () => {
  setPreviewExpanded(!document.body.classList.contains("preview-expanded"));
});
document.getElementById("download-fields-button").addEventListener("click", () => {
  try {
    exportFieldsCsv();
  } catch (error) {
    showError(`No se pudo exportar el CSV de campos: ${error.message}`);
  }
});
document.getElementById("download-records-button").addEventListener("click", (event) => {
  exportRecordsCsv(event.currentTarget);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("preview-expanded")) {
    setPreviewExpanded(false);
  }
});
document.getElementById("analyze-button").addEventListener("click", analyzeFiles);
document.querySelectorAll(".results-view-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelector(".results-grid").dataset.mobileView = tab.dataset.view;
    document.querySelectorAll(".results-view-tab").forEach((item) => {
      const active = item === tab;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
  });
});
document.getElementById("clear-button").addEventListener("click", () => {
  setPreviewExpanded(false);
  loadedDbf = null;
  companions.clear();
  pendingDbfFile = null;
  pendingCompanionFiles.clear();
  dbfInput.value = "";
  companionInput.value = "";
  results.hidden = true;
  errorMessage.hidden = true;
  uploadCard.hidden = false;
  document.body.classList.remove("results-active");
  stageFilesChanged();
});
dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    dbfInput.click();
  }
});
dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("drag-over");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("drag-over");
  const file = Array.from(event.dataTransfer.files).find((item) => item.name.toLowerCase().endsWith(".dbf"));
  if (file) {
    pendingDbfFile = file;
    dbfInput.value = "";
    stageFilesChanged();
  }
  else showError("Arrastra un archivo con extensión .dbf.");
});

updateSelection();

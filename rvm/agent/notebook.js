"use strict";
// Notebook module — Jupyter .ipynb reading
// Maps to official devin-remote NotebookReadInput

const fs = require("fs");

async function handleRoute(body) {
  const { path: filePath, cell_index } = body;
  if (!filePath) return { status: 400, body: { error: "path required" } };

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const nb = JSON.parse(raw);

    if (!nb.cells || !Array.isArray(nb.cells)) {
      return { status: 400, body: { error: "invalid notebook format: no cells array" } };
    }

    // If a specific cell is requested
    if (cell_index !== undefined && cell_index !== null) {
      const idx = parseInt(cell_index);
      if (idx < 0 || idx >= nb.cells.length) {
        return { status: 400, body: { error: `cell_index ${idx} out of range (0-${nb.cells.length - 1})` } };
      }
      const cell = nb.cells[idx];
      return { status: 200, body: formatCell(cell, idx) };
    }

    // Return all cells with metadata
    const cells = nb.cells.map((cell, i) => formatCell(cell, i));
    return {
      status: 200,
      body: {
        path: filePath,
        metadata: nb.metadata || {},
        nbformat: nb.nbformat,
        cell_count: cells.length,
        cells,
      },
    };
  } catch (e) {
    return { status: 500, body: { error: String(e.message || e) } };
  }
}

function formatCell(cell, index) {
  const source = Array.isArray(cell.source) ? cell.source.join("") : (cell.source || "");
  const result = {
    index,
    cell_type: cell.cell_type,
    source,
  };

  if (cell.cell_type === "code") {
    result.execution_count = cell.execution_count;
    if (cell.outputs && cell.outputs.length > 0) {
      result.outputs = cell.outputs.map((out) => {
        if (out.output_type === "stream") {
          return { type: "stream", name: out.name, text: Array.isArray(out.text) ? out.text.join("") : out.text };
        }
        if (out.output_type === "execute_result" || out.output_type === "display_data") {
          const data = {};
          if (out.data) {
            if (out.data["text/plain"]) data.text = Array.isArray(out.data["text/plain"]) ? out.data["text/plain"].join("") : out.data["text/plain"];
            if (out.data["text/html"]) data.html = Array.isArray(out.data["text/html"]) ? out.data["text/html"].join("") : out.data["text/html"];
            if (out.data["image/png"]) data.image_base64 = out.data["image/png"];
          }
          return { type: out.output_type, data };
        }
        if (out.output_type === "error") {
          return { type: "error", ename: out.ename, evalue: out.evalue, traceback: out.traceback };
        }
        return { type: out.output_type };
      });
    }
  }

  return result;
}

module.exports = { handleRoute };

import express from "express";
import morgan from "morgan";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { promises as fsPromises } from "fs";
import axios from "axios";
import puppeteer from "puppeteer";
import { v4 as uuidv4 } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const BASE_URL =
  process.env.BASE_URL ||
  (process.env.RAILWAY_STATIC_URL
    ? `https://${process.env.RAILWAY_STATIC_URL}`
    : null);

const DATA_DIR =
  process.env.DATA_DIR || path.resolve(__dirname, "..", "data");
const CARDS_DIR = path.join(DATA_DIR, "cards");

// Log de configuração na inicialização
console.log("🔧 Configuração do servidor:");
console.log(`   PORT: ${PORT}`);
console.log(`   DATA_DIR: ${DATA_DIR}`);
console.log(`   CARDS_DIR: ${CARDS_DIR}`);
console.log(`   BASE_URL: ${BASE_URL || "não definido"}`);
console.log(`   NODE_ENV: ${process.env.NODE_ENV || "não definido"}`);

// Tempo de expiração dos PDFs em milissegundos (10 minutos)
const PDF_EXPIRATION_TIME = 10 * 60 * 1000; // 10 minutos

// Map para rastrear timers de exclusão dos PDFs
const pdfCleanupTimers = new Map();

async function ensureDirectories() {
  await fsPromises.mkdir(CARDS_DIR, { recursive: true });
}

async function schedulePdfDeletion(pdfPath, fileName) {
  // Cancela timer anterior se existir para o mesmo arquivo
  if (pdfCleanupTimers.has(fileName)) {
    clearTimeout(pdfCleanupTimers.get(fileName));
  }

  // Agenda exclusão após 10 minutos
  const timer = setTimeout(async () => {
    try {
      await fsPromises.unlink(pdfPath);
      pdfCleanupTimers.delete(fileName);
      console.info(`[Limpeza] PDF excluído automaticamente: ${fileName}`);
    } catch (error) {
      // Ignora erro se arquivo já foi deletado
      if (error.code !== "ENOENT") {
        console.error(`[Limpeza] Erro ao excluir PDF ${fileName}:`, error.message);
      }
      pdfCleanupTimers.delete(fileName);
    }
  }, PDF_EXPIRATION_TIME);

  pdfCleanupTimers.set(fileName, timer);
  console.info(`[Limpeza] PDF agendado para exclusão em 10 minutos: ${fileName}`);
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9_\-]/gi, "_").toLowerCase();
}

function makeSlug(date = new Date()) {
  const iso = date.toISOString().split("T")[0];
  const random = uuidv4().slice(0, 8);
  return `cards_${iso}_${random}`;
}

async function fetchImageAsDataUrl(url) {
  if (!url) return null;

  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 10000,
    });

    const mimeType =
      response.headers["content-type"] || "image/png";
    const base64 = Buffer.from(response.data).toString("base64");
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    console.error("[fetchImageAsDataUrl] Falha ao carregar imagem:", {
      url,
      message: error.message,
    });
    return null;
  }
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function escapeHtml(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildHtml({
  logoDataUrl,
  layout,
  pages,
  mode = "pdf",
}) {
  const {
    cols,
    rows,
    marginTop,
    marginBottom,
    marginLeft,
    marginRight,
    gapCol,
    gapRow,
    rotateCard = 0,
    cardWidth,
    cardHeight,
    cardPadding = 8,
    cardMarginTop = 4,
    cardMarginBottom = 4,
    companyName = "Appsculpt",
    companyFont = 3.5,
    nameFont = 4,
    maxCharsName,
    codeFont = 3.2,
    maxCharsCode,
    qrSize = 32,
  } = layout;

  const isPreview = mode === "preview";
  const totalCardsPerPage = cols * rows;
  if (totalCardsPerPage <= 0) {
    throw new Error("Layout inválido: cols * rows deve ser maior que zero.");
  }

  // Quando rotacionado próximo de 90/270 graus, as dimensões do grid precisam ser invertidas
  // para acomodar o card rotacionado
  const normalizedRotate = ((rotateCard % 360) + 360) % 360;
  const isRotated = (normalizedRotate >= 45 && normalizedRotate <= 135) || 
                    (normalizedRotate >= 225 && normalizedRotate <= 315);
  const gridColWidth = isRotated ? cardHeight : cardWidth;
  const gridRowHeight = isRotated ? cardWidth : cardHeight;

  // Calcula altura total do grid baseado nas linhas e gaps
  const gridTotalHeight = rows * gridRowHeight + (rows - 1) * gapRow;
  // Calcula largura total do grid baseado nas colunas e gaps
  const gridTotalWidth = cols * gridColWidth + (cols - 1) * gapCol;

  const css = `
    @page {
      size: A4;
      margin: 0;
    }
    body {
      margin: 0;
      font-family: "Helvetica Neue", Arial, sans-serif;
      color: #111827;
    }
    .page {
      width: 210mm;
      height: 297mm;
      padding: ${marginTop}mm ${marginRight}mm ${marginBottom}mm ${marginLeft}mm;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      position: relative;
    }
    .page + .page {
      page-break-before: always;
    }
    .page-header {
      display: none;
      margin: 0;
      padding: 0;
    }
    .page-header.has-logo {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      min-height: 24mm;
      margin-bottom: 4mm;
      margin-top: 0;
    }
    .logo {
      max-height: 22mm;
      max-width: 80mm;
      object-fit: contain;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(${cols}, ${gridColWidth}mm);
      grid-template-rows: repeat(${rows}, ${gridRowHeight}mm);
      column-gap: ${gapCol}mm;
      row-gap: ${gapRow}mm;
      width: ${gridTotalWidth}mm;
      height: ${gridTotalHeight}mm;
      margin: 0 auto;
      margin-top: 0;
      overflow: visible;
      position: relative;
    }
    .card {
      overflow: visible;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      width: 100%;
      height: 100%;
      background: transparent;
    }
    .card-content {
      width: ${cardWidth}mm;
      height: ${cardHeight}mm;
      padding: ${cardPadding}mm;
      padding-top: ${cardMarginTop}mm;
      padding-bottom: ${cardMarginBottom}mm;
      box-sizing: border-box;
      position: relative;
      transform: rotate(${rotateCard}deg);
      transform-origin: center center;
      background: #fff;
      border: 0.6mm solid #1f2937;
      border-radius: 1.5mm;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      gap: 3mm;
    }
    .company-name {
      font-size: ${companyFont}mm;
      font-weight: 700;
      color: #0f172a;
      text-align: center;
      margin: 0;
      margin-bottom: 2mm;
    }
    .material-name {
      font-size: ${nameFont}mm;
      font-weight: 600;
      color: #0f172a;
      text-align: center;
      margin: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    .material-code {
      font-size: ${codeFont}mm;
      color: #475569;
      text-align: center;
      margin: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    .qr-wrapper {
      width: ${qrSize}mm;
      height: ${qrSize}mm;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f1f5f9;
      border-radius: 4px;
      overflow: hidden;
      flex-shrink: 0;
    }
    .qr-wrapper img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
  `;

  const previewCss = isPreview
    ? `
    body {
      margin: 0;
      font-family: "Helvetica Neue", Arial, sans-serif;
      color: #111827;
      background: #e2e8f0;
      padding: 32px;
      display: flex;
      justify-content: center;
    }
    .document {
      display: flex;
      flex-direction: column;
      gap: 32px;
      align-items: center;
    }
    .page {
      box-shadow: 0 20px 40px rgba(15, 23, 42, 0.25);
      border-radius: 8px;
    }
    .page + .page {
      page-break-before: always;
    }
  `
    : "";

  // Função para truncar texto
  const truncateText = (text, maxChars) => {
    if (!maxChars || maxChars <= 0) return text;
    if (text.length <= maxChars) return text;
    return text.substring(0, maxChars) + "...";
  };

  const htmlPages = pages
    .map((materials, pageIndex) => {
      const cardsHtml = materials
        .map((material) => {
          const { nome, codigo, qrDataUrl } = material;
          const nomeTruncado = truncateText(nome, maxCharsName);
          const codigoTruncado = truncateText(codigo, maxCharsCode);
          return `
            <div class="card">
              <div class="card-content">
                <div class="company-name">${escapeHtml(companyName)}</div>
                <div class="qr-wrapper">
                  ${
                    qrDataUrl
                      ? `<img src="${qrDataUrl}" alt="QR Code">`
                      : `<div style="font-size:3mm;color:#9ca3af;">QR indisponível</div>`
                  }
                </div>
                <div class="material-name">${escapeHtml(nomeTruncado)}</div>
                <div class="material-code">${escapeHtml(codigoTruncado)}</div>
              </div>
            </div>
          `;
        })
        .join("");

      const placeholderCount = totalCardsPerPage - materials.length;
      const placeholders =
        placeholderCount > 0
          ? Array.from({ length: placeholderCount })
              .map(
                () => `
              <div class="card">
                <div class="card-content" style="justify-content:center;">
                  <div style="font-size:3mm;color:#d1d5db;">Vago</div>
                </div>
              </div>
            `
              )
              .join("")
          : "";

      return `
        <section class="page">
          ${
            pageIndex === 0 && logoDataUrl
              ? `
                  <header class="page-header has-logo">
                    <img class="logo" src="${logoDataUrl}" alt="Logo">
                  </header>
                `
              : ""
          }
          <div class="grid">
            ${cardsHtml}
            ${placeholders}
          </div>
        </section>
      `;
    })
    .join("");

  const bodyContent = isPreview
    ? `<main class="document">${htmlPages}</main>`
    : htmlPages;

  return `
    <!DOCTYPE html>
    <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <meta http-equiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Cards de Materiais</title>
        <style>
          ${css}
          ${previewCss}
        </style>
      </head>
      <body>
        ${bodyContent}
      </body>
    </html>
  `;
}

async function generatePdf({
  html,
  outputPath,
}) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
        "--font-render-hinting=medium",
      ],
      timeout: 30000, // 30 segundos de timeout
    });
  } catch (error) {
    console.error("❌ Erro ao iniciar Puppeteer:", error);
    throw new Error(`Falha ao iniciar navegador: ${error.message}`);
  }

  try {
    const page = await browser.newPage();
    await page.setContent(html, {
      waitUntil: ["load", "networkidle0"],
      timeout: 30000,
    });
    await page.emulateMediaType("print");
    await page.pdf({
      path: outputPath,
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      timeout: 30000,
    });
  } catch (error) {
    console.error("❌ Erro ao gerar PDF:", error);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch((err) => {
        console.error("⚠️ Erro ao fechar navegador:", err);
      });
    }
  }
}

function resolveBaseUrl(req) {
  if (BASE_URL) return BASE_URL;
  const host = req.get("host");
  const protocol = req.protocol;
  return `${protocol}://${host}`;
}

function validatePayload(body) {
  if (!body || typeof body !== "object") {
    throw new Error("Payload JSON inválido.");
  }

  const { logoUrl, layout, materials } = body;

  if (!layout || typeof layout !== "object") {
    throw new Error("Campo 'layout' é obrigatório.");
  }

  const {
    cols,
    rows,
    marginTop,
    marginBottom,
    marginLeft,
    marginRight,
    gapCol,
    gapRow,
    rotateCard,
    cardWidth,
    cardHeight,
    cardPadding,
    cardMarginTop,
    cardMarginBottom,
    companyName,
    companyFont,
    nameFont,
    maxCharsName,
    codeFont,
    maxCharsCode,
    qrSize,
  } = layout;

  const requiredLayoutFields = [
    ["cols", cols],
    ["rows", rows],
    ["marginTop", marginTop],
    ["marginBottom", marginBottom],
    ["marginLeft", marginLeft],
    ["marginRight", marginRight],
    ["gapCol", gapCol],
    ["gapRow", gapRow],
    ["cardWidth", cardWidth],
    ["cardHeight", cardHeight],
  ];

  requiredLayoutFields.forEach(([key, value]) => {
    if (typeof value !== "number" || Number.isNaN(value)) {
      throw new Error(`Campo de layout '${key}' deve ser numérico.`);
    }
  });

  if (!Array.isArray(materials) || materials.length === 0) {
    throw new Error("Lista de materiais deve ser um array com pelo menos um item.");
  }

  materials.forEach((material, index) => {
    if (!material.nome || !material.codigo) {
      throw new Error(
        `Material na posição ${index} precisa de 'nome' e 'codigo'.`
      );
    }
  });

  if (rotateCard !== undefined && typeof rotateCard !== "number") {
    throw new Error("Campo 'rotateCard' deve ser numérico.");
  }

  return {
    logoUrl,
    layout: {
      cols,
      rows,
      marginTop,
      marginBottom,
      marginLeft,
      marginRight,
      gapCol,
      gapRow,
      rotateCard: rotateCard || 0,
      cardWidth,
      cardHeight,
      cardPadding: cardPadding !== undefined ? cardPadding : 8,
      cardMarginTop: cardMarginTop !== undefined ? cardMarginTop : 4,
      cardMarginBottom: cardMarginBottom !== undefined ? cardMarginBottom : 4,
      companyName: companyName !== undefined ? companyName : "Appsculpt",
      companyFont: companyFont !== undefined ? companyFont : 3.5,
      nameFont: nameFont !== undefined ? nameFont : 4,
      maxCharsName: maxCharsName !== undefined ? maxCharsName : undefined,
      codeFont: codeFont !== undefined ? codeFont : 3.2,
      maxCharsCode: maxCharsCode !== undefined ? maxCharsCode : undefined,
      qrSize: qrSize !== undefined ? qrSize : 32,
    },
    materials,
  };
}

const app = express();
app.set("trust proxy", true);
app.use(
  cors({
    origin: true, // Permite todas as origens (incluindo localhost e 127.0.0.1)
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(morgan("combined"));

app.use(
  "/files",
  express.static(CARDS_DIR, {
    index: false,
    maxAge: "1h",
    setHeaders: (res) => {
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    },
  })
);

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Servidor de Cards PDF",
    version: "1.0.0",
    endpoints: {
      health: "/health",
      preview: "POST /preview",
      generatePdf: "POST /gerar-pdf",
      view: "GET /view/:fileId",
      files: "GET /files/:fileName",
    },
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/preview", async (req, res, next) => {
  try {
    const payload = validatePayload(req.body);

    const {
      logoUrl,
      layout,
      materials,
    } = payload;

    const cardsPerPage = layout.cols * layout.rows;

    const logoDataUrl = await fetchImageAsDataUrl(logoUrl);
    const materialsWithQr = await Promise.all(
      materials.map(async (material) => ({
        ...material,
        qrDataUrl: await fetchImageAsDataUrl(material.qr),
      }))
    );

    const pages = chunkArray(materialsWithQr, cardsPerPage);

    const html = buildHtml({
      logoDataUrl,
      layout,
      pages,
      mode: "preview",
    });

    res.type("html").send(html);
  } catch (error) {
    next(error);
  }
});

app.post("/gerar-pdf", async (req, res, next) => {
  try {
    const payload = validatePayload(req.body);
    await ensureDirectories();

    const {
      logoUrl,
      layout,
      materials,
    } = payload;

    const cardsPerPage = layout.cols * layout.rows;

    const logoDataUrl = await fetchImageAsDataUrl(logoUrl);
    const materialsWithQr = await Promise.all(
      materials.map(async (material) => ({
        ...material,
        qrDataUrl: await fetchImageAsDataUrl(material.qr),
      }))
    );

    const pages = chunkArray(materialsWithQr, cardsPerPage);

    const html = buildHtml({
      logoDataUrl,
      layout,
      pages,
    });

    const slug = makeSlug();
    const fileBaseName = sanitizeFilename(slug);
    const pdfFileName = `${fileBaseName}.pdf`;
    const pdfPath = path.join(CARDS_DIR, pdfFileName);

    await generatePdf({
      html,
      outputPath: pdfPath,
    });

    // Agenda exclusão automática após 10 minutos
    await schedulePdfDeletion(pdfPath, pdfFileName);

    const baseUrl = resolveBaseUrl(req);
    const viewerId = path.parse(pdfFileName).name;
    const downloadUrl = `${baseUrl}/files/${pdfFileName}`;
    const viewerUrl = `${baseUrl}/view/${viewerId}`;

    console.info("[/gerar-pdf] PDF gerado com sucesso:", {
      pdfPath,
      downloadUrl,
      viewerUrl,
    });

    res.status(201).json({
      status: "ok",
      downloadUrl,
      viewerUrl,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/view/:fileId", async (req, res, next) => {
  try {
    const { fileId } = req.params;
    const sanitizedId = sanitizeFilename(fileId);
    const pdfFileName = `${sanitizedId}.pdf`;
    const pdfPath = path.join(CARDS_DIR, pdfFileName);

    const exists = fs.existsSync(pdfPath);
    if (!exists) {
      return res.status(404).send("Arquivo não encontrado.");
    }

    const baseUrl = resolveBaseUrl(req);
    const downloadPath = `${baseUrl}/files/${pdfFileName}`;

    res.type("html").send(`<!DOCTYPE html>
      <html lang="pt-BR">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Visualização dos Cards</title>
          <style>
            body {
              margin: 0;
              font-family: Arial, sans-serif;
              display: flex;
              flex-direction: column;
              height: 100vh;
              background: #0f172a;
              color: #e2e8f0;
            }
            header {
              padding: 16px;
              text-align: center;
              background: #111c3a;
            }
            header h1 {
              margin: 0;
              font-size: 20px;
            }
            main {
              flex: 1;
              padding: 0;
            }
            .toolbar {
              display: flex;
              justify-content: center;
              gap: 12px;
              padding: 12px;
              background: #0b1120;
            }
            .button {
              display: inline-flex;
              align-items: center;
              justify-content: center;
              padding: 10px 16px;
              font-size: 16px;
              font-weight: 600;
              color: #0b1120;
              background: #38bdf8;
              border-radius: 8px;
              text-decoration: none;
            }
            .viewer-container {
              height: calc(100vh - 160px);
              padding: 0 16px 16px;
            }
            .viewer-container embed,
            .viewer-container iframe {
              width: 100%;
              height: 100%;
              border: none;
              border-radius: 12px;
              box-shadow: 0 10px 30px rgba(15, 23, 42, 0.4);
            }
            @media (max-width: 768px) {
              .viewer-container {
                padding: 0;
                height: calc(100vh - 140px);
              }
              .toolbar {
                flex-direction: column;
                padding: 8px;
              }
              .button {
                width: calc(100% - 24px);
                margin: 0 12px;
              }
            }
          </style>
        </head>
        <body>
          <header>
            <h1>Visualização dos Cards</h1>
          </header>
          <div class="toolbar">
            <a class="button" href="${downloadPath}" download>Baixar PDF</a>
          </div>
          <main class="viewer-container">
            <embed src="${downloadPath}" type="application/pdf" width="100%" height="98%" />
          </main>
        </body>
      </html>`);
  } catch (error) {
    next(error);
  }
});

app.use((err, req, res, _next) => {
  console.error("[Erro]", err);
  const statusCode = err.status || 500;
  res.status(statusCode).json({
    status: "error",
    message: err.message || "Erro interno no servidor.",
  });
});

ensureDirectories()
  .then(() => {
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Servidor iniciado na porta ${PORT}`);
      console.log(`📁 Diretório de dados: ${DATA_DIR}`);
      if (BASE_URL) {
        console.log(`🌐 URL base: ${BASE_URL}`);
      }
      console.log(`💚 Health check disponível em: /health`);
    });

    // Tratamento de erros do servidor
    server.on("error", (error) => {
      console.error("❌ Erro no servidor:", error);
      if (error.code === "EADDRINUSE") {
        console.error(`❌ Porta ${PORT} já está em uso`);
      }
      process.exit(1);
    });
  })
  .catch((error) => {
    console.error("❌ Falha ao preparar diretórios:", error);
    console.error("Stack:", error.stack);
    process.exit(1);
  });

// Tratamento de erros não capturados
process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
  console.error("Stack:", reason?.stack);
  // Não fazemos exit aqui para não derrubar o servidor
});

process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error);
  console.error("Stack:", error.stack);
  // Apenas em casos críticos fazemos exit
  if (error.code === "EADDRINUSE" || error.code === "EACCES") {
    process.exit(1);
  }
});


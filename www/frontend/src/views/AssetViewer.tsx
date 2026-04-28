import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { apiJson } from "../api";
import { toast } from "sonner";
import { ArrowLeft, ChevronLeft, ChevronRight, ScanText } from "lucide-react";

// pdfjs-dist als ESM-Module laden (Worker via URL-Import bei Vite).
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

export function AssetViewer() {
  const { id } = useParams();
  const nav = useNavigate();
  const asset = useLiveQuery(() => (id ? db.assets.get(id) : undefined), [id]);

  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);

  // Bild-URL aus Blob.
  useEffect(() => {
    if (!asset || !asset.mime.startsWith("image/")) {
      setImgUrl(null);
      return;
    }
    const url = URL.createObjectURL(asset.blob);
    setImgUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [asset?.id]);

  // PDF rendern.
  useEffect(() => {
    if (!asset || asset.mime !== "application/pdf" || !canvasRef.current) return;
    let cancelled = false;
    (async () => {
      const buf = await asset.blob.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      if (cancelled) return;
      setPageCount(pdf.numPages);
      const p = await pdf.getPage(Math.min(page, pdf.numPages));
      const viewport = p.getViewport({ scale: 1.5 });
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d")!;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await p.render({ canvasContext: ctx, viewport }).promise;
    })().catch((e) => toast.error("PDF-Render-Fehler: " + e.message));
    return () => {
      cancelled = true;
    };
  }, [asset?.id, page]);

  async function reOcr() {
    if (!id || !asset || !asset.mime.startsWith("image/") || !navigator.onLine) return;
    if (asset.uploaded !== 1) {
      toast.error("Asset wurde noch nicht hochgeladen.");
      return;
    }
    setBusy(true);
    try {
      const r = await apiJson<{ text: string }>(`/ai/vision_ocr?asset_id=${id}`, "POST");
      toast.success(`OCR aktualisiert (${r.text.length} Zeichen)`);
    } catch (e: any) {
      toast.error("OCR fehlgeschlagen: " + e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!asset) return <div className="p-4 text-slate-500">Asset wird geladen…</div>;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-2 border-b bg-white">
        <button onClick={() => nav(-1)} className="p-1 hover:bg-slate-100 rounded">
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 truncate">
          <span className="font-medium">{asset.filename}</span>
          <span className="ml-2 text-xs text-slate-500">{asset.mime}</span>
          {asset.uploaded ? null : (
            <span className="ml-2 text-xs text-amber-600">• unsynchronisiert</span>
          )}
        </div>
        {asset.mime === "application/pdf" && pageCount > 1 && (
          <div className="flex items-center gap-1 text-sm">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="p-1 hover:bg-slate-100 rounded disabled:opacity-30"
            >
              <ChevronLeft size={18} />
            </button>
            <span>
              {page} / {pageCount}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={page >= pageCount}
              className="p-1 hover:bg-slate-100 rounded disabled:opacity-30"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        )}
        {asset.mime.startsWith("image/") && (
          <button
            onClick={reOcr}
            disabled={busy || !navigator.onLine || asset.uploaded !== 1}
            className="flex items-center gap-1 px-2 py-1 text-sm hover:bg-slate-100 rounded disabled:opacity-30"
            title="OCR neu ausführen"
          >
            <ScanText size={16} /> OCR
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto bg-slate-100 p-4 flex justify-center">
        {asset.mime.startsWith("image/") && imgUrl && (
          <img src={imgUrl} alt={asset.filename} className="max-w-full max-h-full object-contain" />
        )}
        {asset.mime === "application/pdf" && (
          <canvas ref={canvasRef} className="shadow-lg bg-white" />
        )}
      </div>
    </div>
  );
}

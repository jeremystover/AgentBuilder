import { useEffect, useState } from "react";
import { api, type CheckImageSummary } from "../api";

interface Props {
  /** /api/web/review/:id or /api/web/transactions/:id */
  endpoint: string;
}

export function CheckImagesPanel({ endpoint }: Props) {
  const [images, setImages] = useState<CheckImageSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openSide, setOpenSide] = useState<"front" | "back">("front");

  useEffect(() => {
    let cancelled = false;
    setImages(null); setError(null);
    api.get<{ check_images: CheckImageSummary[] }>(`${endpoint}/check-images`)
      .then(r => { if (!cancelled) setImages(r.check_images); })
      .catch(e => { if (!cancelled) setError(String(e.message ?? e)); });
    return () => { cancelled = true; };
  }, [endpoint]);

  if (error) {
    return (
      <section>
        <div className="text-xs uppercase text-text-muted mb-1">Check images</div>
        <div className="text-xs text-accent-danger">{error}</div>
      </section>
    );
  }
  if (!images) return null;
  if (images.length === 0) return null;

  return (
    <section>
      <div className="text-xs uppercase text-text-muted mb-1">Check images</div>
      <div className="space-y-2">
        {images.map(img => (
          <div key={img.id} className="bg-bg-elevated rounded-lg p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium">
                  CHECK #{img.check_number ?? "?"}
                  {img.extracted_payee && <span className="ml-2 text-text-muted">→ {img.extracted_payee}</span>}
                </div>
                <div className="text-xs text-text-muted mt-0.5">
                  {statusLabel(img.status)}
                  {img.extraction_confidence != null && img.status !== "pending" && img.status !== "processing" && (
                    <> · confidence {Math.round(Number.parseFloat(img.extraction_confidence) * 100)}%</>
                  )}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => { setOpenId(img.id); setOpenSide("front"); }}
                  className="text-xs underline text-accent-primary"
                >
                  Front
                </button>
                {img.has_back && (
                  <button
                    type="button"
                    onClick={() => { setOpenId(img.id); setOpenSide("back"); }}
                    className="text-xs underline text-accent-primary"
                  >
                    Back
                  </button>
                )}
              </div>
            </div>
            {openId === img.id && (
              <div className="mt-2">
                <img
                  src={`/api/extension/v1/check-images/${img.id}/image/${openSide}`}
                  alt={`Check ${img.check_number ?? ""} ${openSide}`}
                  className="rounded border border-border max-w-full bg-white"
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function statusLabel(s: CheckImageSummary["status"]): string {
  switch (s) {
    case "pending":      return "Queued for analysis…";
    case "processing":   return "Analyzing image…";
    case "analyzed":     return "Analyzed, awaiting match";
    case "attached":     return "Attached to this transaction";
    case "match_failed": return "No matching transaction found";
    case "error":        return "Analysis failed";
  }
}

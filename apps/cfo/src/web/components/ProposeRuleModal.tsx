import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button, Input, Select, Modal } from "./ui";
import { api, type Entity, type Category, type ReviewRow } from "../api";

type MatchKind = "description_contains" | "description_starts_with" | "merchant_equals";

interface Props {
  open: boolean;
  onClose: () => void;
  sourceRow: ReviewRow | null;
  entities: Entity[];
  categories: Category[];
  onCreated: () => void;
}

function suggestedToken(row: ReviewRow): string {
  if (row.merchant) return row.merchant;
  // First meaningful token of description (skip leading "POS", "ACH", etc.)
  return (row.description ?? "")
    .split(/\s+/)
    .find(t => t.length > 3 && !/^(POS|ACH|DBT|CHK|CHECK|DEP|XFER|TRANSFER)$/i.test(t))
    ?? row.description ?? "";
}

export function ProposeRuleModal({ open, onClose, sourceRow, entities, categories, onCreated }: Props) {
  const [matchKind, setMatchKind] = useState<MatchKind>("description_contains");
  const [matchValue, setMatchValue] = useState("");
  const [entityId, setEntityId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!sourceRow) return;
    const tok = sourceRow.merchant ?? suggestedToken(sourceRow);
    setMatchKind(sourceRow.merchant ? "merchant_equals" : "description_contains");
    setMatchValue(tok);
    setEntityId(sourceRow.entity_id ?? "");
    setCategoryId(sourceRow.category_id ?? "");
    setName(`${tok} → ${categories.find(c => c.id === sourceRow.category_id)?.name ?? "?"}`);
  }, [sourceRow, categories]);

  const matchJson = useMemo(() => ({ [matchKind]: matchValue }), [matchKind, matchValue]);

  const submit = async () => {
    if (!matchValue || !entityId || !categoryId) {
      toast.error("Match value, entity, and category are required.");
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/web/rules", {
        name,
        match_json: matchJson,
        entity_id: entityId,
        category_id: categoryId,
        created_by: "user",
      });
      onCreated();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Propose rule"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>Add rule</Button>
        </>
      }
    >
      {sourceRow && (
        <div className="space-y-3 text-sm">
          <div className="bg-bg-elevated rounded-lg p-3">
            <div className="text-xs uppercase text-text-muted mb-1">Source transaction</div>
            <div className="font-medium">{sourceRow.description}</div>
            {sourceRow.merchant && <div className="text-text-muted">{sourceRow.merchant}</div>}
          </div>

          <div>
            <label className="block text-xs text-text-muted mb-1">Rule name</label>
            <Input className="w-full" value={name} onChange={e => setName(e.target.value)} />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-xs text-text-muted mb-1">Match</label>
              <Select value={matchKind} onChange={e => setMatchKind(e.target.value as MatchKind)}>
                <option value="description_contains">desc contains</option>
                <option value="description_starts_with">desc starts with</option>
                <option value="merchant_equals">merchant equals</option>
              </Select>
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-text-muted mb-1">Value</label>
              <Input className="w-full" value={matchValue} onChange={e => setMatchValue(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-text-muted mb-1">Entity</label>
              <Select value={entityId} onChange={e => setEntityId(e.target.value)}>
                <option value="">— select —</option>
                {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Category</label>
              <Select value={categoryId} onChange={e => setCategoryId(e.target.value)}>
                <option value="">— select —</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
